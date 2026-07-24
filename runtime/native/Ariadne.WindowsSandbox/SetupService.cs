using System.Security.Principal;

namespace Ariadne.WindowsSandbox;

internal static class SetupService
{
    internal static bool IsAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    internal static StatusResponse Apply(SetupRequest request, string argumentStateRoot)
    {
        var policy = PathPolicy.Normalize(request, argumentStateRoot);
        if (!IsAdministrator())
        {
            return SetupElevation.Run(request, argumentStateRoot);
        }
        HelperPublisherTrust.EnsureCurrentExecutableTrusted();
        StateStorage.ValidateSecureRootLocation(policy.StateRoot);
        var currentStatus = SandboxControlPlane.GetStatus(request, argumentStateRoot);
        if (currentStatus.Status == "ready") return currentStatus;

        var ownerSid = WindowsIdentity.GetCurrent().User ?? throw new SetupException("owner_sid_unavailable");
        var filesystemCapabilitySid = WindowsAppContainerProfile.DeriveFilesystemCapability(policy, ownerSid);
        var previousManifest = LoadTrustedPreviousManifest(policy.StateRoot, ownerSid);
        WindowsSandboxBrokerServiceManager.QuiesceForSetup(policy, ownerSid);
        if (previousManifest is not null)
        {
            var previousPolicy = new DesiredPolicy(
                policy.StateRoot,
                previousManifest.WorkspaceRoot,
                previousManifest.WritableRoots,
                previousManifest.ToolReadRoots,
                previousManifest.ReadOnlySubpaths,
                previousManifest.OfflineUser,
                previousManifest.OnlineUser,
                previousManifest.WriterGroup,
                previousManifest.AllowLoopback,
                previousManifest.PolicyDigest);
            new SandboxArtifactLeaseStore(policy.StateRoot, ownerSid)
                .RecoverForSetup(previousPolicy, previousManifest);
        }
        StateStorage.PrepareRoot(policy.StateRoot, ownerSid);
        if (previousManifest is not null) WorkspaceAclManager.Revoke(previousManifest);
        var identity = WindowsAccountManager.Provision(policy);
        WindowsAccountVisibility.Apply(policy);
        CredentialVault.Save(policy, ownerSid, identity.OfflinePassword, identity.OnlinePassword);
        WorkspaceAclManager.Apply(policy, identity, filesystemCapabilitySid);
        var firewallRule = FirewallManager.Apply(identity.OfflineUserSid, policy.AllowLoopback);
        WindowsSandboxBrokerServiceManager.Apply(policy, ownerSid);
        WindowsAccountLogonPolicy.Apply(policy);
        var manifest = new SetupManifest
        {
            Version = 2,
            PolicyDigest = policy.Digest,
            OwnerSid = ownerSid.Value,
            OfflineUser = policy.OfflineUser,
            OfflineUserSid = identity.OfflineUserSid,
            OnlineUser = policy.OnlineUser,
            OnlineUserSid = identity.OnlineUserSid,
            WriterGroup = policy.WriterGroup,
            WriterGroupSid = identity.WriterGroupSid,
            FilesystemCapabilitySid = filesystemCapabilitySid.Value,
            FirewallRule = firewallRule,
            WorkspaceRoot = policy.WorkspaceRoot,
            WritableRoots = [.. policy.WritableRoots],
            ToolReadRoots = [.. policy.ToolReadRoots],
            ReadOnlySubpaths = [.. policy.ReadOnlySubpaths],
            AllowLoopback = policy.AllowLoopback,
        };
        var verification = SetupVerifier.Verify(policy, manifest, ownerSid);
        if (verification is not null) throw new SetupException(verification);
        if (previousManifest is not null)
        {
            WindowsAccountManager.RetirePreviousIdentities(previousManifest, policy);
            WindowsAccountVisibility.RetirePrevious(previousManifest, policy);
        }
        StateStorage.WriteJsonAtomic(policy.StateRoot, StateStorage.ManifestFileName, manifest, ownerSid);
        var finalStatus = SandboxControlPlane.GetStatus(request, argumentStateRoot);
        if (finalStatus.Status != "ready") throw new SetupException("setup_postcondition_failed");
        return finalStatus;
    }

    private static SetupManifest? LoadTrustedPreviousManifest(string stateRoot, SecurityIdentifier ownerSid)
    {
        var manifestPath = Path.Combine(stateRoot, StateStorage.ManifestFileName);
        if (!File.Exists(manifestPath)) return null;
        if (!StateStorage.VerifyRoot(stateRoot, ownerSid) || !StateStorage.VerifyFile(manifestPath, ownerSid))
        {
            throw new SetupException("previous_manifest_untrusted");
        }
        SetupManifest manifest;
        try
        {
            manifest = StateStorage.ReadJson<SetupManifest>(stateRoot, StateStorage.ManifestFileName, 1024 * 1024)
                ?? throw new SetupException("previous_manifest_missing");
        }
        catch (Exception error) when (error is System.Text.Json.JsonException or IOException or UnauthorizedAccessException)
        {
            throw new SetupException("previous_manifest_invalid", error);
        }
        if (manifest.Version is not (1 or 2) ||
            !string.Equals(manifest.OwnerSid, ownerSid.Value, StringComparison.Ordinal))
        {
            throw new SetupException("previous_manifest_identity_invalid");
        }
        return manifest;
    }
}

internal static class SetupVerifier
{
    internal static string? Verify(DesiredPolicy policy, SetupManifest manifest, SecurityIdentifier ownerSid)
    {
        try
        {
            if (!StateStorage.VerifyRoot(policy.StateRoot, ownerSid)) return "state_root_acl_invalid";
            if (!StateStorage.VerifyFile(Path.Combine(policy.StateRoot, StateStorage.VaultFileName), ownerSid))
            {
                return "credential_vault_acl_invalid";
            }
            if (!SandboxArtifactLeaseStore.Verify(policy.StateRoot, ownerSid, manifest))
            {
                return "sandbox_artifact_lease_invalid";
            }
            var passwords = CredentialVault.Load(policy, ownerSid);
            if (!WindowsAccountManager.Verify(
                    policy,
                    manifest,
                    passwords.OfflinePassword,
                    passwords.OnlinePassword))
            {
                return "managed_identity_invalid";
            }
            if (!WindowsAccountVisibility.Verify(policy)) return "account_visibility_invalid";
            if (!WindowsSandboxBrokerServiceManager.Verify(policy, ownerSid)) return "broker_service_invalid";
            if (!WindowsAccountLogonPolicy.Verify(policy)) return "account_logon_policy_invalid";
            var expectedCapability = WindowsAppContainerProfile.DeriveFilesystemCapability(policy, ownerSid);
            if (!string.Equals(
                    manifest.FilesystemCapabilitySid,
                    expectedCapability.Value,
                    StringComparison.Ordinal))
            {
                return "filesystem_capability_invalid";
            }
            if (!WorkspaceAclManager.Verify(policy, manifest)) return "workspace_acl_invalid";
            if (!string.Equals(manifest.FirewallRule, FirewallManager.RulePrefix, StringComparison.Ordinal) ||
                !FirewallManager.Verify(manifest.OfflineUserSid, policy.AllowLoopback))
            {
                return "firewall_rule_invalid";
            }
            return null;
        }
        catch (SetupException error)
        {
            return error.Code;
        }
        catch (Exception error) when (error is IdentityNotMappedException or UnauthorizedAccessException or IOException)
        {
            return "managed_identity_invalid";
        }
    }
}
