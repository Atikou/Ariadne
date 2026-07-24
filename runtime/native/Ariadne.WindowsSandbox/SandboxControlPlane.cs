using System.Security.Principal;
using System.Text.Json;

namespace Ariadne.WindowsSandbox;

internal static class SandboxControlPlane
{
    private const long MaxManifestBytes = 1024 * 1024;

    internal static StatusResponse GetStatus(SetupRequest request, string argumentStateRoot)
    {
        var policy = PathPolicy.Normalize(request, argumentStateRoot);
        SetupManifest? manifest;
        try
        {
            manifest = StateStorage.ReadJson<SetupManifest>(
                policy.StateRoot,
                StateStorage.ManifestFileName,
                MaxManifestBytes);
        }
        catch (SetupException error)
        {
            return BuildStatus(policy, "setup_required", $"manifest_invalid:{error.Code}");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return BuildStatus(policy, "setup_required", $"manifest_invalid:{error.GetType().Name}");
        }
        if (manifest is null)
        {
            return BuildStatus(policy, "setup_required", "manifest_missing");
        }
        if (manifest.Version != 2)
        {
            return BuildStatus(policy, "setup_required", "manifest_version_mismatch");
        }
        if (!string.Equals(manifest.PolicyDigest, policy.Digest, StringComparison.Ordinal))
        {
            return BuildStatus(policy, "setup_required", "policy_changed");
        }
        if (!ManifestMatchesPolicy(manifest, policy))
        {
            return BuildStatus(policy, "setup_required", "manifest_policy_mismatch");
        }

        var currentSid = WindowsIdentity.GetCurrent().User?.Value;
        if (string.IsNullOrWhiteSpace(currentSid) || !string.Equals(manifest.OwnerSid, currentSid, StringComparison.Ordinal))
        {
            return BuildStatus(policy, "setup_required", "manifest_owner_mismatch");
        }
        if (!StateStorage.VerifyFile(
                Path.Combine(policy.StateRoot, StateStorage.ManifestFileName),
                new SecurityIdentifier(currentSid)))
        {
            return BuildStatus(policy, "setup_required", "manifest_acl_invalid");
        }
        var verification = SetupVerifier.Verify(policy, manifest, new SecurityIdentifier(currentSid));
        return verification is null
            ? BuildStatus(policy, "ready", null, manifest)
            : BuildStatus(policy, "setup_required", $"native_controls_unverified:{verification}", manifest);
    }

    internal static ExecutionAuthorization AuthorizeExecution(
        ExecutionRequest request,
        string stateRoot)
    {
        var normalizedStateRoot = PathPolicy.NormalizeAbsolute(stateRoot, "--state-root");
        SetupManifest? manifest;
        try
        {
            manifest = StateStorage.ReadJson<SetupManifest>(
                normalizedStateRoot,
                StateStorage.ManifestFileName,
                1024 * 1024);
        }
        catch (Exception error) when (error is SetupException or IOException or UnauthorizedAccessException or JsonException)
        {
            throw new NativeExecutionException(
                "setup_required",
                "manifest_invalid",
                innerException: error);
        }
        if (manifest is null)
        {
            throw new NativeExecutionException("setup_required", "manifest_missing");
        }
        var setupRequest = new SetupRequest
        {
            StateRoot = normalizedStateRoot,
            WorkspaceRoot = request.WorkspaceRoot,
            WritableRoots = [.. request.WritableRoots],
            ToolReadRoots = [.. request.ToolReadRoots],
            ReadOnlySubpaths = [.. request.ReadOnlySubpaths],
            OfflineUser = manifest.OfflineUser,
            OnlineUser = manifest.OnlineUser,
            WriterGroup = manifest.WriterGroup,
            AllowLoopback = manifest.AllowLoopback,
        };
        var status = GetStatus(setupRequest, normalizedStateRoot);
        if (status.Status != "ready")
        {
            throw new NativeExecutionException(
                "setup_required",
                status.Reason ?? "setup_required");
        }

        var policy = PathPolicy.Normalize(setupRequest, normalizedStateRoot);
        var ownerSid = WindowsIdentity.GetCurrent().User ?? throw new NativeExecutionException(
            "credential_failure",
            "current Windows identity has no SID");
        var writeScope = request.WriteScope is null
            ? null
            : EphemeralWriteScopeManager.Prepare(request.WriteScope, policy, manifest, ownerSid);
        var passwords = CredentialVault.Load(policy, ownerSid);
        var offline = request.NetworkMode == "offline";
        return new ExecutionAuthorization(
            policy,
            manifest,
            offline ? manifest.OfflineUser : manifest.OnlineUser,
            offline ? manifest.OfflineUserSid : manifest.OnlineUserSid,
            offline ? passwords.OfflinePassword : passwords.OnlinePassword,
            writeScope?.CapabilitySid ?? (request.Mode == "workspace-write" ? manifest.WriterGroupSid : "S-1-5-12"),
            writeScope);
    }

    internal static void RequireExecutionManifest(string stateRoot)
    {
        var normalizedStateRoot = PathPolicy.NormalizeAbsolute(stateRoot, "--state-root");
        try
        {
            if (StateStorage.ReadJson<SetupManifest>(
                    normalizedStateRoot,
                    StateStorage.ManifestFileName,
                    MaxManifestBytes) is null)
            {
                throw new NativeExecutionException("setup_required", "manifest_missing");
            }
        }
        catch (NativeExecutionException)
        {
            throw;
        }
        catch (Exception error) when (error is SetupException or IOException or UnauthorizedAccessException or JsonException)
        {
            throw new NativeExecutionException("setup_required", "manifest_invalid", innerException: error);
        }
    }

    internal static StatusResponse BuildStatus(
        DesiredPolicy policy,
        string status,
        string? reason,
        SetupManifest? manifest = null) => new()
    {
        Status = status,
        PolicyDigest = policy.Digest,
        Reason = reason,
        OfflineUser = policy.OfflineUser,
        OfflineUserSid = manifest?.OfflineUserSid,
        OnlineUser = policy.OnlineUser,
        OnlineUserSid = manifest?.OnlineUserSid,
        WriterGroup = policy.WriterGroup,
        WriterGroupSid = manifest?.WriterGroupSid,
        FilesystemCapabilitySid = manifest?.FilesystemCapabilitySid,
        FirewallRule = manifest?.FirewallRule,
        WorkspaceRoot = policy.WorkspaceRoot,
        WritableRoots = policy.WritableRoots,
        ToolReadRoots = policy.ToolReadRoots,
        ReadOnlySubpaths = policy.ReadOnlySubpaths,
        AllowLoopback = policy.AllowLoopback,
    };

    private static bool ManifestMatchesPolicy(SetupManifest manifest, DesiredPolicy policy) =>
        string.Equals(manifest.OfflineUser, policy.OfflineUser, StringComparison.Ordinal) &&
        string.Equals(manifest.OnlineUser, policy.OnlineUser, StringComparison.Ordinal) &&
        string.Equals(manifest.WriterGroup, policy.WriterGroup, StringComparison.Ordinal) &&
        PathPolicy.PathEquals(manifest.WorkspaceRoot, policy.WorkspaceRoot) &&
        manifest.WritableRoots.SequenceEqual(policy.WritableRoots, StringComparer.OrdinalIgnoreCase) &&
        manifest.ToolReadRoots.SequenceEqual(policy.ToolReadRoots, StringComparer.OrdinalIgnoreCase) &&
        manifest.ReadOnlySubpaths.SequenceEqual(policy.ReadOnlySubpaths, StringComparer.OrdinalIgnoreCase) &&
        manifest.AllowLoopback == policy.AllowLoopback;
}
