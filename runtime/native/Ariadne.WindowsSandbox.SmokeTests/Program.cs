using System.Security.AccessControl;
using System.Security.Principal;
using Ariadne.WindowsSandbox;

if (args.Length != 4)
{
    Console.Error.WriteLine("expected <directory> <file> <junction> <hardlink>");
    return 2;
}

ExpectMoveDetected(args[0], isDirectory: true);
ExpectMoveDetected(args[1], isDirectory: false);
RoundTrip(args[0], requireDirectory: true);
RoundTrip(args[1], requireDirectory: false);
ExpectIdentityRejection(args[2]);
ExpectHardLink(args[3]);
VerifyAuthorizationAclCeiling();
VerifyProtectedExplicitDeny();
VerifyFirewallPolicySnapshot();
Console.WriteLine("acl_handle_smoke_ok");
return 0;

static void RoundTrip(string path, bool requireDirectory)
{
    var canonicalPath = WindowsPathResolver.Canonicalize(Path.GetFullPath(path));
    using var target = WindowsAclHandle.Open(
        canonicalPath,
        AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
        requireDirectory,
        "smoke_target_missing");
    var before = target.ReadSecurity(AccessControlSections.Access);
    var expected = before.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
    target.WriteSecurity(before, setOwner: false, setDaclProtection: false);
    var actual = target.ReadSecurity(AccessControlSections.Access)
        .GetSecurityDescriptorSddlForm(AccessControlSections.Access);
    if (!string.Equals(actual, expected, StringComparison.Ordinal))
    {
        throw new InvalidOperationException("acl_round_trip_changed_descriptor");
    }
}

static void ExpectMoveDetected(string path, bool isDirectory)
{
    var canonicalPath = WindowsPathResolver.Canonicalize(Path.GetFullPath(path));
    using var target = WindowsAclHandle.Open(
        canonicalPath,
        AclHandleAccess.ReadControl,
        isDirectory,
        "smoke_move_target_missing");
    var moved = $"{path}.moved";
    var didMove = false;
    try
    {
        if (isDirectory)
        {
            Directory.Move(path, moved);
        }
        else
        {
            File.Move(path, moved);
        }
        didMove = true;
    }
    catch (IOException)
    {
        return;
    }
    try
    {
        _ = target.ReadSecurity(AccessControlSections.Access);
    }
    catch (SetupException error) when (error.Code == "acl_path_identity_changed")
    {
        return;
    }
    finally
    {
        if (didMove)
        {
            if (isDirectory)
            {
                Directory.Move(moved, path);
            }
            else
            {
                File.Move(moved, path);
            }
        }
    }
    throw new InvalidOperationException("acl_target_move_was_not_detected");
}

static void ExpectIdentityRejection(string path)
{
    var parent = Path.GetDirectoryName(Path.GetFullPath(path))
        ?? throw new InvalidOperationException("junction_parent_missing");
    var expectedPath = Path.Combine(
        WindowsPathResolver.Canonicalize(parent),
        Path.GetFileName(path));
    try
    {
        using var target = WindowsAclHandle.Open(
            expectedPath,
            AclHandleAccess.ReadControl,
            requireDirectory: true,
            "smoke_junction_missing");
    }
    catch (SetupException error) when (error.Code == "acl_path_identity_changed")
    {
        return;
    }
    throw new InvalidOperationException("junction_identity_was_not_rejected");
}

static void ExpectHardLink(string path)
{
    var canonicalPath = WindowsPathResolver.Canonicalize(Path.GetFullPath(path));
    using var target = WindowsAclHandle.Open(
        canonicalPath,
        0,
        requireDirectory: false,
        "smoke_hardlink_missing");
    if (target.LinkCount <= 1)
    {
        throw new InvalidOperationException("hardlink_count_was_not_detected");
    }
}

static void VerifyProtectedExplicitDeny()
{
    var workspace = Path.Combine(Path.GetTempPath(), $"ariadne-protected-acl-{Guid.NewGuid():N}");
    var protectedRoot = Path.Combine(workspace, "protected");
    var child = Path.Combine(protectedRoot, "child.txt");
    var offlineSid = new SecurityIdentifier("S-1-5-21-999999991-999999992-999999993-1101");
    var onlineSid = new SecurityIdentifier("S-1-5-21-999999991-999999992-999999993-1102");
    var writerSid = new SecurityIdentifier("S-1-5-21-999999991-999999992-999999993-1103");
    var filesystemCapabilitySid = WindowsAppContainerProfile.DeriveCapabilitySid(
        $"Ariadne.acl-smoke.{Guid.NewGuid():N}");
    Directory.CreateDirectory(protectedRoot);
    File.WriteAllText(child, "protected acl smoke");
    workspace = WindowsPathResolver.Canonicalize(workspace);
    protectedRoot = WindowsPathResolver.Canonicalize(protectedRoot);
    child = WindowsPathResolver.Canonicalize(child);
    var policy = new DesiredPolicy(
        workspace,
        workspace,
        [],
        [],
        [protectedRoot],
        "SmokeOffline",
        "SmokeOnline",
        "SmokeWriters",
        false,
        "smoke-policy");
    var identity = new ManagedIdentity(
        offlineSid.Value,
        onlineSid.Value,
        writerSid.Value,
        "unused",
        "unused");
    var manifest = new SetupManifest
    {
        Version = 2,
        PolicyDigest = policy.Digest,
        OwnerSid = offlineSid.Value,
        OfflineUser = policy.OfflineUser,
        OfflineUserSid = offlineSid.Value,
        OnlineUser = policy.OnlineUser,
        OnlineUserSid = onlineSid.Value,
        WriterGroup = policy.WriterGroup,
        WriterGroupSid = writerSid.Value,
        FilesystemCapabilitySid = filesystemCapabilitySid.Value,
        FirewallRule = "unused",
        WorkspaceRoot = workspace,
        ReadOnlySubpaths = [protectedRoot],
    };
    try
    {
        using (var target = WindowsAclHandle.Open(
                   WindowsPathResolver.Canonicalize(child),
                   AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
                   requireDirectory: false,
                   "protected_smoke_child_missing"))
        {
            var security = target.ReadSecurity(AccessControlSections.Access);
            security.AddAccessRule(new FileSystemAccessRule(
                writerSid,
                FileSystemRights.FullControl,
                AccessControlType.Allow));
            target.WriteSecurity(security, setOwner: false, setDaclProtection: false);
        }

        WorkspaceAclManager.ApplyProtectedRulesForTest(policy, identity, filesystemCapabilitySid);
        if (!WorkspaceAclManager.VerifyProtectedRulesForTest(policy, manifest))
        {
            throw new InvalidOperationException("protected_tree_verification_failed");
        }
        using var childHandle = WindowsAclHandle.Open(
            WindowsPathResolver.Canonicalize(child),
            AclHandleAccess.ReadControl,
            requireDirectory: false,
            "protected_smoke_child_missing");
        var writerRules = childHandle.ReadSecurity(AccessControlSections.Access)
            .GetAccessRules(true, true, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .Where(rule => rule.IdentityReference.Equals(writerSid))
            .ToArray();
        var capabilityRules = childHandle.ReadSecurity(AccessControlSections.Access)
            .GetAccessRules(true, true, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .Where(rule => rule.IdentityReference.Equals(filesystemCapabilitySid))
            .ToArray();
        if (writerRules.Length == 0 || writerRules[0].IsInherited ||
            writerRules[0].AccessControlType != AccessControlType.Deny)
        {
            throw new InvalidOperationException("protected_explicit_deny_not_canonical_first");
        }
        if (capabilityRules.Length == 0 || capabilityRules[0].IsInherited ||
            capabilityRules[0].AccessControlType != AccessControlType.Deny)
        {
            throw new InvalidOperationException("protected_capability_deny_not_canonical_first");
        }
        childHandle.Dispose();
        using (var writableChild = WindowsAclHandle.Open(
                   child,
                   AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
                   requireDirectory: false,
                   "protected_smoke_child_missing"))
        {
            var security = writableChild.ReadSecurity(AccessControlSections.Access);
            foreach (var rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier))
                         .Cast<FileSystemAccessRule>()
                         .Where(rule =>
                             rule.IdentityReference.Equals(filesystemCapabilitySid) &&
                             rule.AccessControlType == AccessControlType.Deny)
                         .ToArray())
            {
                security.RemoveAccessRuleSpecific(rule);
            }
            writableChild.WriteSecurity(security, setOwner: false, setDaclProtection: false);
        }
        if (WorkspaceAclManager.VerifyProtectedRulesForTest(policy, manifest))
        {
            throw new InvalidOperationException("protected_capability_deny_drift_was_accepted");
        }
        WorkspaceAclManager.ApplyProtectedRulesForTest(policy, identity, filesystemCapabilitySid);
        if (!WorkspaceAclManager.VerifyProtectedRulesForTest(policy, manifest))
        {
            throw new InvalidOperationException("protected_capability_deny_drift_was_not_repaired");
        }
    }
    finally
    {
        try
        {
            WorkspaceAclManager.RevokeProtectedRulesForTest(manifest);
        }
        finally
        {
            Directory.Delete(workspace, recursive: true);
        }
    }
}

static void VerifyAuthorizationAclCeiling()
{
    var container = Path.Combine(Path.GetTempPath(), $"ariadne-authorization-acl-{Guid.NewGuid():N}");
    var root = Path.Combine(container, "root");
    var child = Path.Combine(root, "child.txt");
    var offlineSid = new SecurityIdentifier("S-1-5-21-999999981-999999982-999999983-1201");
    var onlineSid = new SecurityIdentifier("S-1-5-21-999999981-999999982-999999983-1202");
    var writerSid = new SecurityIdentifier("S-1-5-21-999999981-999999982-999999983-1203");
    var filesystemCapabilitySid = WindowsAppContainerProfile.DeriveCapabilitySid(
        $"Ariadne.authorization-acl-smoke.{Guid.NewGuid():N}");
    var identity = new ManagedIdentity(
        offlineSid.Value,
        onlineSid.Value,
        writerSid.Value,
        "unused",
        "unused");
    Directory.CreateDirectory(root);
    File.WriteAllText(child, "authorization acl smoke");
    root = WindowsPathResolver.Canonicalize(root);
    child = WindowsPathResolver.Canonicalize(child);
    try
    {
        AddAllow(child, offlineSid, FileSystemRights.FullControl);
        AddAllow(child, filesystemCapabilitySid, FileSystemRights.FullControl);
        if (WorkspaceAclManager.VerifyAuthorizationTreeForTest(
                root,
                identity,
                filesystemCapabilitySid,
                writable: true))
        {
            throw new InvalidOperationException("authorization_excess_allow_was_accepted");
        }
        WorkspaceAclManager.ApplyAuthorizationTreeForTest(
            root,
            identity,
            filesystemCapabilitySid,
            writable: true);
        if (!WorkspaceAclManager.VerifyAuthorizationTreeForTest(
                root,
                identity,
                filesystemCapabilitySid,
                writable: true))
        {
            throw new InvalidOperationException("authorization_excess_allow_was_not_repaired");
        }
        AddDeny(child, filesystemCapabilitySid, FileSystemRights.ReadData);
        if (WorkspaceAclManager.VerifyAuthorizationTreeForTest(
                root,
                identity,
                filesystemCapabilitySid,
                writable: true))
        {
            throw new InvalidOperationException("authorization_conflicting_deny_was_accepted");
        }
        WorkspaceAclManager.ApplyAuthorizationTreeForTest(
            root,
            identity,
            filesystemCapabilitySid,
            writable: true);
        if (!WorkspaceAclManager.VerifyAuthorizationTreeForTest(
                root,
                identity,
                filesystemCapabilitySid,
                writable: true))
        {
            throw new InvalidOperationException("authorization_conflicting_deny_was_not_repaired");
        }

        WorkspaceAclManager.ApplyAuthorizationTreeForTest(
            root,
            identity,
            filesystemCapabilitySid,
            writable: false);
        AddAllow(child, writerSid, FileSystemRights.FullControl);
        if (WorkspaceAclManager.VerifyAuthorizationTreeForTest(
                root,
                identity,
                filesystemCapabilitySid,
                writable: false))
        {
            throw new InvalidOperationException("tool_read_writer_allow_was_accepted");
        }
        WorkspaceAclManager.ApplyAuthorizationTreeForTest(
            root,
            identity,
            filesystemCapabilitySid,
            writable: false);
        if (!WorkspaceAclManager.VerifyAuthorizationTreeForTest(
                root,
                identity,
                filesystemCapabilitySid,
                writable: false))
        {
            throw new InvalidOperationException("tool_read_writer_allow_was_not_removed");
        }
        Console.WriteLine("authorization_acl_ceiling_smoke_ok");

        AddAllow(container, filesystemCapabilitySid, FileSystemRights.FullControl, inherit: true);
        if (WorkspaceAclManager.VerifyAuthorizationTreeForTest(
                root,
                identity,
                filesystemCapabilitySid,
                writable: false))
        {
            throw new InvalidOperationException("inherited_authorization_excess_allow_was_accepted");
        }
        try
        {
            WorkspaceAclManager.ApplyAuthorizationTreeForTest(
                root,
                identity,
                filesystemCapabilitySid,
                writable: false);
        }
        catch (SetupException error) when (error.Code == "authorization_inherited_allow_exceeds_policy")
        {
            Console.WriteLine("authorization_inherited_acl_fail_closed_ok");
            return;
        }
        throw new InvalidOperationException("inherited_authorization_excess_allow_was_not_rejected");
    }
    finally
    {
        Directory.Delete(container, recursive: true);
    }
}

static void VerifyFirewallPolicySnapshot()
{
    const string offlineSid = "S-1-5-21-999999971-999999972-999999973-1301";
    const string prefix = "Ariadne-Sandbox-Offline-v1";
    var allRule = CreateFirewallRule(
        $"{prefix}-all",
        ["Any"],
        $"O:LSD:(A;;CC;;;{offlineSid})");
    var allSnapshot = new FirewallPolicySnapshot
    {
        FirewallServiceStatus = "Running",
        Profiles = CreateFirewallProfiles(),
        ManagedRuleNames = [allRule.Name],
        Rules = [allRule],
    };
    if (!FirewallManager.VerifySnapshotForTest(allSnapshot, offlineSid, allowLoopback: false))
    {
        throw new InvalidOperationException("complete_firewall_snapshot_was_rejected");
    }

    var narrowedRules = new[]
    {
        allRule with { Protocol = "TCP" },
        allRule with { RemotePorts = ["443"] },
        allRule with { Program = @"C:\Windows\System32\curl.exe" },
        allRule with { Service = "Dnscache" },
        allRule with { InterfaceType = "Wireless" },
        allRule with { InterfaceAliases = ["Ethernet"] },
        allRule with { RemoteUser = offlineSid },
        allRule with { NegatedFilters = ["address"] },
    };
    foreach (var narrowedRule in narrowedRules)
    {
        var narrowed = allSnapshot with { Rules = [narrowedRule] };
        if (FirewallManager.VerifySnapshotForTest(narrowed, offlineSid, allowLoopback: false))
        {
            throw new InvalidOperationException("narrowed_firewall_filter_was_accepted");
        }
    }
    if (FirewallManager.VerifySnapshotForTest(
            allSnapshot with { ManagedRuleNames = [allRule.Name, $"{prefix}-rogue"] },
            offlineSid,
            allowLoopback: false))
    {
        throw new InvalidOperationException("unexpected_managed_firewall_rule_was_accepted");
    }
    var invalidSystemStates = new[]
    {
        allSnapshot with { FirewallServiceStatus = "Stopped" },
        allSnapshot with
        {
            Profiles = MutateFirstProfile(CreateFirewallProfiles(), profile => profile with { Enabled = "False" }),
        },
        allSnapshot with
        {
            Profiles = MutateFirstProfile(
                CreateFirewallProfiles(),
                profile => profile with { AllowLocalFirewallRules = "NotConfigured" }),
        },
        allSnapshot with
        {
            Profiles = MutateFirstProfile(
                CreateFirewallProfiles(),
                profile => profile with { DisabledInterfaceAliases = ["Ethernet"] }),
        },
    };
    foreach (var invalidSystemState in invalidSystemStates)
    {
        if (FirewallManager.VerifySnapshotForTest(invalidSystemState, offlineSid, allowLoopback: false))
        {
            throw new InvalidOperationException("disabled_firewall_system_state_was_accepted");
        }
    }

    var ipv4Rule = CreateFirewallRule(
        $"{prefix}-ipv4",
        ["0.0.0.0-126.255.255.255", "128.0.0.0-255.255.255.255"],
        $"D:(A;;CC;;;{offlineSid})");
    var ipv6Rule = CreateFirewallRule(
        $"{prefix}-ipv6",
        ["::", "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
        $"D:(A;;CC;;;{offlineSid})");
    var loopbackSnapshot = new FirewallPolicySnapshot
    {
        FirewallServiceStatus = "Running",
        Profiles = CreateFirewallProfiles(),
        ManagedRuleNames = [ipv6Rule.Name, ipv4Rule.Name],
        Rules = [ipv4Rule, ipv6Rule],
    };
    if (!FirewallManager.VerifySnapshotForTest(loopbackSnapshot, offlineSid, allowLoopback: true))
    {
        throw new InvalidOperationException("loopback_firewall_snapshot_was_rejected");
    }
    var incompleteLoopback = loopbackSnapshot with
    {
        Rules = [ipv4Rule, ipv6Rule with { RemoteAddresses = ["::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"] }],
    };
    if (FirewallManager.VerifySnapshotForTest(incompleteLoopback, offlineSid, allowLoopback: true))
    {
        throw new InvalidOperationException("incomplete_loopback_firewall_ranges_were_accepted");
    }
    Console.WriteLine("firewall_full_filter_snapshot_ok");
}

static FirewallProfileSnapshot[] CreateFirewallProfiles() =>
[
    new FirewallProfileSnapshot
    {
        Name = "Domain",
        Enabled = "True",
        AllowLocalFirewallRules = "True",
        DisabledInterfaceAliases = [],
    },
    new FirewallProfileSnapshot
    {
        Name = "Private",
        Enabled = "True",
        AllowLocalFirewallRules = "True",
        DisabledInterfaceAliases = [],
    },
    new FirewallProfileSnapshot
    {
        Name = "Public",
        Enabled = "True",
        AllowLocalFirewallRules = "True",
        DisabledInterfaceAliases = [],
    },
];

static FirewallProfileSnapshot[] MutateFirstProfile(
    FirewallProfileSnapshot[] profiles,
    Func<FirewallProfileSnapshot, FirewallProfileSnapshot> mutate) =>
    [mutate(profiles[0]), .. profiles.Skip(1)];

static FirewallRuleSnapshot CreateFirewallRule(
    string name,
    string[] remoteAddresses,
    string localUser) => new()
{
    Name = name,
    Enabled = "True",
    Direction = "Outbound",
    Action = "Block",
    Profile = "Any",
    PrimaryStatus = "OK",
    PolicyStoreSourceType = "Local",
    EdgeTraversalPolicy = "Block",
    LooseSourceMapping = false,
    LocalOnlyMapping = false,
    LocalAddresses = ["Any"],
    RemoteAddresses = remoteAddresses,
    Protocol = "Any",
    LocalPorts = ["Any"],
    RemotePorts = ["Any"],
    IcmpType = "Any",
    DynamicTarget = "Any",
    Program = "Any",
    Package = "",
    Service = "Any",
    InterfaceType = "Any",
    InterfaceAliases = ["Any"],
    Authentication = "NotRequired",
    Encryption = "NotRequired",
    OverrideBlockRules = false,
    LocalUser = localUser,
    RemoteUser = "Any",
    RemoteMachine = "Any",
    NegatedFilters = [],
};

static void AddAllow(
    string path,
    SecurityIdentifier sid,
    FileSystemRights rights,
    bool inherit = false)
    => AddRule(path, sid, rights, AccessControlType.Allow, inherit);

static void AddDeny(
    string path,
    SecurityIdentifier sid,
    FileSystemRights rights,
    bool inherit = false)
    => AddRule(path, sid, rights, AccessControlType.Deny, inherit);

static void AddRule(
    string path,
    SecurityIdentifier sid,
    FileSystemRights rights,
    AccessControlType controlType,
    bool inherit)
{
    using var target = WindowsAclHandle.Open(
        path,
        AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
        requireDirectory: null,
        "authorization_smoke_target_missing");
    var security = target.ReadSecurity(AccessControlSections.Access);
    security.AddAccessRule(new FileSystemAccessRule(
        sid,
        rights,
        inherit ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
        PropagationFlags.None,
        controlType));
    target.WriteSecurity(security, setOwner: false, setDaclProtection: false);
}
