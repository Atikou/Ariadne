using System.Security.AccessControl;
using System.Security.Principal;

namespace Ariadne.WindowsSandbox;

internal static class WorkspaceAclManager
{
    private const int MaxProtectedObjects = 250_000;
    private const int MaxWritableObjects = 500_000;
    private const FileSystemRights ProtectedWriteRights =
        FileSystemRights.WriteData |
        FileSystemRights.CreateFiles |
        FileSystemRights.AppendData |
        FileSystemRights.CreateDirectories |
        FileSystemRights.WriteExtendedAttributes |
        FileSystemRights.WriteAttributes |
        FileSystemRights.Delete |
        FileSystemRights.DeleteSubdirectoriesAndFiles |
        FileSystemRights.ChangePermissions |
        FileSystemRights.TakeOwnership;
    private const FileSystemRights IdentityMutationRights =
        FileSystemRights.Write |
        FileSystemRights.Delete |
        FileSystemRights.DeleteSubdirectoriesAndFiles |
        FileSystemRights.ChangePermissions |
        FileSystemRights.TakeOwnership;
    private const FileSystemRights AncestorTraversalRights =
        FileSystemRights.Traverse |
        FileSystemRights.ReadAttributes |
        FileSystemRights.Synchronize;

    internal static void Apply(
        DesiredPolicy policy,
        ManagedIdentity identity,
        SecurityIdentifier filesystemCapabilitySid)
    {
        var offlineSid = new SecurityIdentifier(identity.OfflineUserSid);
        var onlineSid = new SecurityIdentifier(identity.OnlineUserSid);
        var writerSid = new SecurityIdentifier(identity.WriterGroupSid);
        ValidateWritableTrees(WriteRoots(policy));
        foreach (var root in WriteRoots(policy))
        {
            UpdateRules(root, requireDirectory: true, "writable_root_missing", (_, security) =>
            {
                NormalizeManagedAllowRule(security, offlineSid, FileSystemRights.ReadAndExecute, inherit: true);
                NormalizeManagedAllowRule(security, onlineSid, FileSystemRights.ReadAndExecute, inherit: true);
                NormalizeManagedAllowRule(security, writerSid, FileSystemRights.Modify, inherit: true);
                NormalizeManagedAllowRule(security, filesystemCapabilitySid, FileSystemRights.Modify, inherit: true);
            });
            ApplyExistingTreeRules(
                root,
                offlineSid,
                onlineSid,
                writerSid,
                filesystemCapabilitySid,
                writable: true);
        }
        foreach (var root in ToolReadRoots(policy))
        {
            UpdateRules(root, requireDirectory: true, "tool_read_root_missing", (_, security) =>
            {
                NormalizeManagedAllowRule(security, offlineSid, FileSystemRights.ReadAndExecute, inherit: true);
                NormalizeManagedAllowRule(security, onlineSid, FileSystemRights.ReadAndExecute, inherit: true);
                NormalizeManagedAllowRule(security, writerSid, expected: null, inherit: true);
                NormalizeManagedAllowRule(security, filesystemCapabilitySid, FileSystemRights.ReadAndExecute, inherit: true);
            });
            ApplyExistingTreeRules(
                root,
                offlineSid,
                onlineSid,
                writerSid,
                filesystemCapabilitySid,
                writable: false);
        }
        foreach (var ancestor in BoundaryAncestors(WriteRoots(policy).Concat(ToolReadRoots(policy))))
        {
            UpdateRules(ancestor, requireDirectory: true, "authorization_ancestor_missing", (_, security) =>
            {
                NormalizeManagedAllowRule(
                    security,
                    filesystemCapabilitySid,
                    AncestorTraversalRights,
                    inherit: false);
            });
        }
        ApplyProtectedRules(policy, offlineSid, onlineSid, writerSid, filesystemCapabilitySid);
    }

    internal static void ApplyProtectedRulesForTest(
        DesiredPolicy policy,
        ManagedIdentity identity,
        SecurityIdentifier filesystemCapabilitySid) => ApplyProtectedRules(
        policy,
        new SecurityIdentifier(identity.OfflineUserSid),
        new SecurityIdentifier(identity.OnlineUserSid),
        new SecurityIdentifier(identity.WriterGroupSid),
        filesystemCapabilitySid);

    internal static void ApplyAuthorizationTreeForTest(
        string root,
        ManagedIdentity identity,
        SecurityIdentifier filesystemCapabilitySid,
        bool writable) => ApplyExistingTreeRules(
            WindowsPathResolver.Canonicalize(root),
            new SecurityIdentifier(identity.OfflineUserSid),
            new SecurityIdentifier(identity.OnlineUserSid),
            new SecurityIdentifier(identity.WriterGroupSid),
            filesystemCapabilitySid,
            writable);

    internal static bool VerifyAuthorizationTreeForTest(
        string root,
        ManagedIdentity identity,
        SecurityIdentifier filesystemCapabilitySid,
        bool writable) => VerifyExistingTreeRules(
            WindowsPathResolver.Canonicalize(root),
            new SecurityIdentifier(identity.OfflineUserSid),
            new SecurityIdentifier(identity.OnlineUserSid),
            new SecurityIdentifier(identity.WriterGroupSid),
            filesystemCapabilitySid,
            writable);

    private static void ApplyProtectedRules(
        DesiredPolicy policy,
        SecurityIdentifier offlineSid,
        SecurityIdentifier onlineSid,
        SecurityIdentifier writerSid,
        SecurityIdentifier filesystemCapabilitySid)
    {
        foreach (var protectedPath in MinimalProtectedRoots(policy.ReadOnlySubpaths))
        {
            WalkProtectedTree(
                protectedPath,
                AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
                "read_only_subpath_missing",
                (target, security, _) =>
                {
                    ReplaceRule(
                        security,
                        writerSid,
                        ProtectedWriteRights,
                        AccessControlType.Deny,
                        inherit: target.IsDirectory);
                    ReplaceRule(
                        security,
                        filesystemCapabilitySid,
                        ProtectedWriteRights,
                        AccessControlType.Deny,
                        inherit: target.IsDirectory);
                    ReplaceRule(
                        security,
                        offlineSid,
                        FileSystemRights.ReadAndExecute,
                        AccessControlType.Allow,
                        inherit: target.IsDirectory);
                    ReplaceRule(
                        security,
                        onlineSid,
                        FileSystemRights.ReadAndExecute,
                        AccessControlType.Allow,
                        inherit: target.IsDirectory);
                    ReplaceRule(
                        security,
                        filesystemCapabilitySid,
                        FileSystemRights.ReadAndExecute,
                        AccessControlType.Allow,
                        inherit: target.IsDirectory);
                    return true;
                });
        }
    }

    internal static bool Verify(DesiredPolicy policy, SetupManifest manifest)
    {
        try
        {
            var offlineSid = new SecurityIdentifier(manifest.OfflineUserSid);
            var onlineSid = new SecurityIdentifier(manifest.OnlineUserSid);
            var writerSid = new SecurityIdentifier(manifest.WriterGroupSid);
            if (string.IsNullOrWhiteSpace(manifest.FilesystemCapabilitySid)) return false;
            var filesystemCapabilitySid = new SecurityIdentifier(manifest.FilesystemCapabilitySid);
            foreach (var root in WriteRoots(policy))
            {
                using var target = WindowsAclHandle.Open(
                    root,
                    AclHandleAccess.ReadControl,
                    requireDirectory: true,
                    "writable_root_missing");
                var rules = ReadRules(
                    target.ReadSecurity(AccessControlSections.Access),
                    includeInherited: true);
                if (!HasConfiguredRule(rules, offlineSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, inherit: true) ||
                    !HasConfiguredRule(rules, onlineSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, inherit: true) ||
                    !HasConfiguredRule(rules, writerSid, FileSystemRights.Modify, AccessControlType.Allow, inherit: true) ||
                    !HasConfiguredRule(rules, filesystemCapabilitySid, FileSystemRights.Modify, AccessControlType.Allow, inherit: true) ||
                    !HasBoundedEffectiveAllow(rules, offlineSid, FileSystemRights.ReadAndExecute) ||
                    !HasBoundedEffectiveAllow(rules, onlineSid, FileSystemRights.ReadAndExecute) ||
                    !HasBoundedEffectiveAllow(rules, writerSid, FileSystemRights.Modify) ||
                    !HasBoundedEffectiveAllow(rules, filesystemCapabilitySid, FileSystemRights.Modify))
                {
                    return false;
                }
                if (!VerifyExistingTreeRules(
                        root,
                        offlineSid,
                        onlineSid,
                        writerSid,
                        filesystemCapabilitySid,
                        writable: true)) return false;
            }
            foreach (var root in ToolReadRoots(policy))
            {
                using var target = WindowsAclHandle.Open(
                    root,
                    AclHandleAccess.ReadControl,
                    requireDirectory: true,
                    "tool_read_root_missing");
                var rules = ReadRules(target.ReadSecurity(AccessControlSections.Access), includeInherited: true);
                if (!HasConfiguredRule(rules, offlineSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, inherit: true) ||
                    !HasConfiguredRule(rules, onlineSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, inherit: true) ||
                    !HasConfiguredRule(rules, filesystemCapabilitySid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, inherit: true) ||
                    !HasBoundedEffectiveAllow(rules, offlineSid, FileSystemRights.ReadAndExecute) ||
                    !HasBoundedEffectiveAllow(rules, onlineSid, FileSystemRights.ReadAndExecute) ||
                    !HasNoEffectiveAllow(rules, writerSid) ||
                    !HasBoundedEffectiveAllow(rules, filesystemCapabilitySid, FileSystemRights.ReadAndExecute))
                {
                    return false;
                }
                if (!VerifyExistingTreeRules(
                        root,
                        offlineSid,
                        onlineSid,
                        writerSid,
                        filesystemCapabilitySid,
                        writable: false)) return false;
            }
            foreach (var ancestor in BoundaryAncestors(WriteRoots(policy).Concat(ToolReadRoots(policy))))
            {
                using var target = WindowsAclHandle.Open(
                    ancestor,
                    AclHandleAccess.ReadControl,
                    requireDirectory: true,
                    "authorization_ancestor_missing");
                var rules = ReadRules(target.ReadSecurity(AccessControlSections.Access), includeInherited: true);
                if (!HasExactConfiguredRule(
                        rules,
                        filesystemCapabilitySid,
                        AncestorTraversalRights,
                        AccessControlType.Allow,
                        inherit: false) ||
                    !HasBoundedEffectiveAllow(rules, filesystemCapabilitySid, AncestorTraversalRights)) return false;
            }
            if (!VerifyProtectedRules(
                    policy,
                    offlineSid,
                    onlineSid,
                    writerSid,
                    filesystemCapabilitySid)) return false;
            return true;
        }
        catch (Exception error) when (error is SetupException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    internal static bool VerifyProtectedRulesForTest(
        DesiredPolicy policy,
        SetupManifest manifest)
    {
        if (string.IsNullOrWhiteSpace(manifest.FilesystemCapabilitySid)) return false;
        try
        {
            return VerifyProtectedRules(
                policy,
                new SecurityIdentifier(manifest.OfflineUserSid),
                new SecurityIdentifier(manifest.OnlineUserSid),
                new SecurityIdentifier(manifest.WriterGroupSid),
                new SecurityIdentifier(manifest.FilesystemCapabilitySid));
        }
        catch (Exception error) when (error is SetupException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    private static bool VerifyProtectedRules(
        DesiredPolicy policy,
        SecurityIdentifier offlineSid,
        SecurityIdentifier onlineSid,
        SecurityIdentifier writerSid,
        SecurityIdentifier filesystemCapabilitySid)
    {
        foreach (var protectedPath in MinimalProtectedRoots(policy.ReadOnlySubpaths))
        {
            var valid = true;
            WalkProtectedTree(
                protectedPath,
                AclHandleAccess.ReadControl,
                "read_only_subpath_missing",
                (target, security, _) =>
                {
                    var rules = ReadRules(security, includeInherited: true);
                    if (!HasConfiguredRule(rules, writerSid, ProtectedWriteRights, AccessControlType.Deny, target.IsDirectory) ||
                        !HasConfiguredRule(rules, filesystemCapabilitySid, ProtectedWriteRights, AccessControlType.Deny, target.IsDirectory) ||
                        !HasConfiguredRule(rules, offlineSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, target.IsDirectory) ||
                        !HasConfiguredRule(rules, onlineSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, target.IsDirectory) ||
                        !HasConfiguredRule(rules, filesystemCapabilitySid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, target.IsDirectory) ||
                        !HasEffectiveRule(rules, writerSid, ProtectedWriteRights, AccessControlType.Deny) ||
                        !HasEffectiveRule(rules, filesystemCapabilitySid, ProtectedWriteRights, AccessControlType.Deny) ||
                        !HasEffectiveRule(rules, offlineSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow) ||
                        !HasEffectiveRule(rules, onlineSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow) ||
                        !HasEffectiveRule(rules, filesystemCapabilitySid, FileSystemRights.ReadAndExecute, AccessControlType.Allow) ||
                        HasAllowedRights(rules, offlineSid, IdentityMutationRights) ||
                        HasAllowedRights(rules, onlineSid, IdentityMutationRights))
                    {
                        valid = false;
                    }
                    return false;
                });
            if (!valid) return false;
        }
        return true;
    }

    internal static void Revoke(SetupManifest manifest)
    {
        var managedSids = ManagedSids(manifest);
        RevokeProtectedRules(manifest, managedSids);
        foreach (var root in new[] { manifest.WorkspaceRoot }
                     .Concat(manifest.WritableRoots)
                     .Concat(manifest.ToolReadRoots)
                     .Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!Directory.Exists(root)) continue;
            WalkAuthorizationTree(
                root,
                AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
                "previous_authorization_root_missing",
                (_, security) => RemoveManagedRules(security, managedSids));
        }
        if (!string.IsNullOrWhiteSpace(manifest.FilesystemCapabilitySid))
        {
            var filesystemCapabilitySid = new SecurityIdentifier(manifest.FilesystemCapabilitySid);
            foreach (var ancestor in BoundaryAncestors(
                         new[] { manifest.WorkspaceRoot }
                             .Concat(manifest.WritableRoots)
                             .Concat(manifest.ToolReadRoots)))
            {
                if (!Directory.Exists(ancestor)) continue;
                UpdateRules(ancestor, requireDirectory: true, "previous_authorization_ancestor_missing", (_, security) =>
                {
                    RemoveManagedRules(security, [filesystemCapabilitySid]);
                });
            }
        }
    }

    internal static void RevokeProtectedRulesForTest(SetupManifest manifest) =>
        RevokeProtectedRules(manifest, ManagedSids(manifest));

    private static List<SecurityIdentifier> ManagedSids(SetupManifest manifest)
    {
        var managedSids = new List<SecurityIdentifier>
        {
            new(manifest.OfflineUserSid),
            new(manifest.OnlineUserSid),
            new(manifest.WriterGroupSid),
        };
        if (!string.IsNullOrWhiteSpace(manifest.FilesystemCapabilitySid))
        {
            managedSids.Add(new SecurityIdentifier(manifest.FilesystemCapabilitySid));
        }
        return managedSids;
    }

    private static void RevokeProtectedRules(
        SetupManifest manifest,
        IReadOnlyCollection<SecurityIdentifier> managedSids)
    {
        foreach (var protectedPath in MinimalProtectedRoots(manifest.ReadOnlySubpaths))
        {
            if (!PathExists(protectedPath)) continue;
            WalkProtectedTree(
                protectedPath,
                AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
                "previous_protected_path_missing",
                (target, security, isRoot) => RemoveManagedRules(security, managedSids));
        }
    }

    private static void ApplyExistingTreeRules(
        string root,
        SecurityIdentifier offlineSid,
        SecurityIdentifier onlineSid,
        SecurityIdentifier writerSid,
        SecurityIdentifier filesystemCapabilitySid,
        bool writable)
    {
        WalkAuthorizationTree(
            root,
            AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
            "authorization_root_missing",
            (target, security) =>
            {
                var filesystemRights = writable ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute;
                var changed = NormalizeManagedAllowRule(
                    security,
                    offlineSid,
                    FileSystemRights.ReadAndExecute,
                    target.IsDirectory);
                changed |= NormalizeManagedAllowRule(
                    security,
                    onlineSid,
                    FileSystemRights.ReadAndExecute,
                    target.IsDirectory);
                changed |= NormalizeManagedAllowRule(
                    security,
                    writerSid,
                    writable ? FileSystemRights.Modify : null,
                    target.IsDirectory);
                changed |= NormalizeManagedAllowRule(
                    security,
                    filesystemCapabilitySid,
                    filesystemRights,
                    target.IsDirectory);
                return changed;
            });
    }

    private static bool VerifyExistingTreeRules(
        string root,
        SecurityIdentifier offlineSid,
        SecurityIdentifier onlineSid,
        SecurityIdentifier writerSid,
        SecurityIdentifier filesystemCapabilitySid,
        bool writable)
    {
        var valid = true;
        WalkAuthorizationTree(
            root,
            AclHandleAccess.ReadControl,
            "authorization_root_missing",
            (_, security) =>
            {
                var rules = ReadRules(security, includeInherited: true);
                var filesystemRights = writable ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute;
                if (!HasBoundedEffectiveAllow(rules, offlineSid, FileSystemRights.ReadAndExecute) ||
                    !HasBoundedEffectiveAllow(rules, onlineSid, FileSystemRights.ReadAndExecute) ||
                    !(writable
                        ? HasBoundedEffectiveAllow(rules, writerSid, FileSystemRights.Modify)
                        : HasNoEffectiveAllow(rules, writerSid)) ||
                    !HasBoundedEffectiveAllow(rules, filesystemCapabilitySid, filesystemRights))
                {
                    valid = false;
                }
                return false;
            });
        return valid;
    }

    private static IEnumerable<string> WriteRoots(DesiredPolicy policy)
    {
        yield return policy.WorkspaceRoot;
        foreach (var root in policy.WritableRoots)
        {
            if (!PathPolicy.PathEquals(root, policy.WorkspaceRoot)) yield return root;
        }
    }

    private static IEnumerable<string> ToolReadRoots(DesiredPolicy policy)
    {
        var writeRoots = WriteRoots(policy).ToArray();
        foreach (var root in policy.ToolReadRoots)
        {
            if (!writeRoots.Any(writeRoot => PathPolicy.IsSameOrDescendant(root, writeRoot)))
            {
                yield return root;
            }
        }
    }

    private static IReadOnlyList<string> MinimalProtectedRoots(IEnumerable<string> roots)
    {
        var result = new List<string>();
        foreach (var root in roots
                     .Distinct(StringComparer.OrdinalIgnoreCase)
                     .OrderBy(root => root.Length)
                     .ThenBy(root => root, StringComparer.OrdinalIgnoreCase))
        {
            if (!result.Any(parent => PathPolicy.IsSameOrDescendant(root, parent))) result.Add(root);
        }
        return result;
    }

    private static void UpdateRules(
        string path,
        bool? requireDirectory,
        string missingCode,
        Action<WindowsAclHandle, FileSystemSecurity> update)
    {
        using var target = WindowsAclHandle.Open(
            path,
            AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
            requireDirectory,
            missingCode);
        var security = target.ReadSecurity(AccessControlSections.Access);
        update(target, security);
        target.WriteSecurity(security, setOwner: false, setDaclProtection: false);
    }

    private static void WalkProtectedTree(
        string protectedRoot,
        AclHandleAccess access,
        string missingCode,
        Func<WindowsAclHandle, FileSystemSecurity, bool, bool> visit)
    {
        var pending = new Stack<(string Path, bool IsRoot)>();
        pending.Push((protectedRoot, true));
        var visited = 0;
        while (pending.TryPop(out var current))
        {
            visited++;
            if (visited > MaxProtectedObjects)
            {
                throw new SetupException("protected_tree_object_limit_exceeded");
            }
            using var target = WindowsAclHandle.Open(
                current.Path,
                access,
                requireDirectory: null,
                current.IsRoot ? missingCode : "protected_descendant_missing");
            if (!target.IsDirectory && target.LinkCount > 1)
            {
                throw new SetupException("protected_tree_hardlink_unsupported");
            }
            var security = target.ReadSecurity(AccessControlSections.Access);
            if (visit(target, security, current.IsRoot))
            {
                target.WriteSecurity(security, setOwner: false, setDaclProtection: false);
            }
            if (!target.IsDirectory) continue;

            string[] children;
            try
            {
                children = Directory.GetFileSystemEntries(target.Path);
            }
            catch (Exception error) when (error is UnauthorizedAccessException or IOException)
            {
                throw new SetupException("protected_tree_enumeration_failed", error);
            }
            foreach (var child in children)
            {
                var childPath = Path.GetFullPath(child);
                if (!PathPolicy.IsSameOrDescendant(childPath, protectedRoot) ||
                    PathPolicy.PathEquals(childPath, protectedRoot))
                {
                    throw new SetupException("protected_tree_path_escape");
                }
                pending.Push((childPath, false));
            }
        }
    }

    private static void WalkAuthorizationTree(
        string root,
        AclHandleAccess access,
        string missingCode,
        Func<WindowsAclHandle, FileSystemSecurity, bool> visit)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        var visited = 0;
        while (pending.TryPop(out var current))
        {
            visited++;
            if (visited > MaxWritableObjects)
            {
                throw new SetupException("authorization_tree_object_limit_exceeded");
            }
            using var target = WindowsAclHandle.Open(
                current,
                access,
                requireDirectory: null,
                PathPolicy.PathEquals(current, root) ? missingCode : "authorization_descendant_missing");
            if (!target.IsDirectory && target.LinkCount > 1)
            {
                throw new SetupException("authorization_tree_hardlink_unsupported");
            }
            var security = target.ReadSecurity(AccessControlSections.Access);
            if (visit(target, security))
            {
                target.WriteSecurity(security, setOwner: false, setDaclProtection: false);
            }
            if (!target.IsDirectory || (File.GetAttributes(target.Path) & FileAttributes.ReparsePoint) != 0) continue;
            string[] children;
            try
            {
                children = Directory.GetFileSystemEntries(target.Path);
            }
            catch (Exception error) when (error is UnauthorizedAccessException or IOException)
            {
                throw new SetupException("authorization_tree_enumeration_failed", error);
            }
            foreach (var child in children)
            {
                var childPath = Path.GetFullPath(child);
                if (!PathPolicy.IsSameOrDescendant(childPath, root) || PathPolicy.PathEquals(childPath, root))
                {
                    throw new SetupException("authorization_tree_path_escape");
                }
                pending.Push(childPath);
            }
        }
    }

    private static IEnumerable<string> BoundaryAncestors(IEnumerable<string> roots)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in roots)
        {
            var current = Directory.GetParent(root);
            while (current is not null)
            {
                var canonical = WindowsPathResolver.Canonicalize(current.FullName);
                result.Add(canonical);
                current = current.Parent;
            }
        }
        return result.OrderBy(path => path.Length).ThenBy(path => path, StringComparer.OrdinalIgnoreCase);
    }

    private static void ReplaceRule(
        FileSystemSecurity security,
        SecurityIdentifier sid,
        FileSystemRights rights,
        AccessControlType controlType,
        bool inherit)
    {
        foreach (var existing in ReadRules(security, includeInherited: false)
                     .Where(rule => rule.IdentityReference.Equals(sid) && rule.AccessControlType == controlType)
                     .ToArray())
        {
            security.RemoveAccessRuleSpecific(existing);
        }
        security.AddAccessRule(new FileSystemAccessRule(
            sid,
            rights,
            inherit ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
            PropagationFlags.None,
            controlType));
    }

    private static bool NormalizeManagedAllowRule(
        FileSystemSecurity security,
        SecurityIdentifier sid,
        FileSystemRights? expected,
        bool inherit)
    {
        var current = ReadRules(security, includeInherited: true);
        if (expected is null
                ? HasNoEffectiveAllow(current, sid)
                : HasBoundedEffectiveAllow(current, sid, expected.Value))
        {
            return false;
        }

        var changed = RemoveExplicitRules(security, sid, AccessControlType.Allow);
        if (expected is not null)
        {
            changed |= RemoveExplicitRules(security, sid, AccessControlType.Deny);
        }
        var remaining = ReadRules(security, includeInherited: true);
        if (expected is null)
        {
            if (!HasNoEffectiveAllow(remaining, sid))
            {
                throw new SetupException("authorization_inherited_allow_exceeds_policy");
            }
            return changed;
        }
        if (HasAllowedRightsOutside(remaining, sid, expected.Value))
        {
            throw new SetupException("authorization_inherited_allow_exceeds_policy");
        }
        if (HasDeniedRights(remaining, sid, expected.Value))
        {
            throw new SetupException("authorization_inherited_deny_conflicts_policy");
        }
        if (!HasEffectiveRule(remaining, sid, expected.Value, AccessControlType.Allow))
        {
            security.AddAccessRule(new FileSystemAccessRule(
                sid,
                expected.Value,
                inherit ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
                PropagationFlags.None,
                AccessControlType.Allow));
            changed = true;
        }
        return changed;
    }

    private static bool RemoveExplicitRules(
        FileSystemSecurity security,
        SecurityIdentifier sid,
        AccessControlType controlType)
    {
        var changed = false;
        foreach (var existing in ReadRules(security, includeInherited: false)
                     .Where(rule => rule.IdentityReference.Equals(sid) && rule.AccessControlType == controlType)
                     .ToArray())
        {
            security.RemoveAccessRuleSpecific(existing);
            changed = true;
        }
        return changed;
    }

    private static bool RemoveManagedRules(
        FileSystemSecurity security,
        IReadOnlyCollection<SecurityIdentifier> managedSids)
    {
        var changed = false;
        foreach (var rule in ReadRules(security, includeInherited: false)
                     .Where(rule => managedSids.Any(sid => rule.IdentityReference.Equals(sid)))
                     .ToArray())
        {
            security.RemoveAccessRuleSpecific(rule);
            changed = true;
        }
        return changed;
    }

    private static FileSystemAccessRule[] ReadRules(FileSystemSecurity security, bool includeInherited) =>
        security.GetAccessRules(true, includeInherited, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .ToArray();

    private static bool HasConfiguredRule(
        IEnumerable<FileSystemAccessRule> rules,
        SecurityIdentifier sid,
        FileSystemRights expected,
        AccessControlType type,
        bool inherit) => rules.Any(rule =>
            !rule.IsInherited &&
            rule.IdentityReference.Equals(sid) &&
            rule.AccessControlType == type &&
            (rule.FileSystemRights & expected) == expected &&
            rule.InheritanceFlags == (inherit
                ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit
                : InheritanceFlags.None) &&
            rule.PropagationFlags == PropagationFlags.None);

    private static bool HasExactConfiguredRule(
        IEnumerable<FileSystemAccessRule> rules,
        SecurityIdentifier sid,
        FileSystemRights expected,
        AccessControlType type,
        bool inherit) => rules.Any(rule =>
            !rule.IsInherited &&
            rule.IdentityReference.Equals(sid) &&
            rule.AccessControlType == type &&
            rule.FileSystemRights == expected &&
            rule.InheritanceFlags == (inherit
                ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit
                : InheritanceFlags.None) &&
            rule.PropagationFlags == PropagationFlags.None);

    private static bool HasEffectiveRule(
        IEnumerable<FileSystemAccessRule> rules,
        SecurityIdentifier sid,
        FileSystemRights expected,
        AccessControlType type) => rules.Any(rule =>
            rule.IdentityReference.Equals(sid) &&
            rule.AccessControlType == type &&
            (rule.FileSystemRights & expected) == expected);

    private static bool HasBoundedEffectiveAllow(
        IEnumerable<FileSystemAccessRule> rules,
        SecurityIdentifier sid,
        FileSystemRights expected)
    {
        var snapshot = rules.ToArray();
        return HasEffectiveRule(snapshot, sid, expected, AccessControlType.Allow) &&
               !HasAllowedRightsOutside(snapshot, sid, expected) &&
               !HasDeniedRights(snapshot, sid, expected);
    }

    private static bool HasNoEffectiveAllow(
        IEnumerable<FileSystemAccessRule> rules,
        SecurityIdentifier sid) => !rules.Any(rule =>
            rule.IdentityReference.Equals(sid) &&
            rule.AccessControlType == AccessControlType.Allow &&
            ((int)rule.FileSystemRights & (int)FileSystemRights.FullControl) != 0);

    private static bool HasAllowedRightsOutside(
        IEnumerable<FileSystemAccessRule> rules,
        SecurityIdentifier sid,
        FileSystemRights expected)
    {
        var allowedMask = (int)(expected | FileSystemRights.Synchronize);
        var forbiddenMask = (int)FileSystemRights.FullControl & ~allowedMask;
        return rules.Any(rule =>
            rule.IdentityReference.Equals(sid) &&
            rule.AccessControlType == AccessControlType.Allow &&
            ((int)rule.FileSystemRights & forbiddenMask) != 0);
    }

    private static bool HasDeniedRights(
        IEnumerable<FileSystemAccessRule> rules,
        SecurityIdentifier sid,
        FileSystemRights expected) => rules.Any(rule =>
            rule.IdentityReference.Equals(sid) &&
            rule.AccessControlType == AccessControlType.Deny &&
            (rule.FileSystemRights & expected) != 0);

    private static bool HasAllowedRights(
        IEnumerable<FileSystemAccessRule> rules,
        SecurityIdentifier sid,
        FileSystemRights forbidden) => rules.Any(rule =>
            rule.IdentityReference.Equals(sid) &&
            rule.AccessControlType == AccessControlType.Allow &&
            (rule.FileSystemRights & forbidden) != 0);

    private static bool PathExists(string path) => Directory.Exists(path) || File.Exists(path);

    private static void ValidateWritableTrees(IEnumerable<string> roots)
    {
        var minimalRoots = new List<string>();
        foreach (var root in roots
                     .Distinct(StringComparer.OrdinalIgnoreCase)
                     .OrderBy(root => root.Length)
                     .ThenBy(root => root, StringComparer.OrdinalIgnoreCase))
        {
            if (!minimalRoots.Any(parent => PathPolicy.IsSameOrDescendant(root, parent))) minimalRoots.Add(root);
        }
        var visited = 0;
        foreach (var root in minimalRoots)
        {
            var pending = new Stack<string>();
            pending.Push(root);
            while (pending.TryPop(out var current))
            {
                visited++;
                if (visited > MaxWritableObjects)
                {
                    throw new SetupException("writable_tree_object_limit_exceeded");
                }
                FileAttributes attributes;
                try
                {
                    attributes = File.GetAttributes(current);
                }
                catch (Exception error) when (error is UnauthorizedAccessException or IOException)
                {
                    throw new SetupException("writable_tree_enumeration_failed", error);
                }
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                var isDirectory = (attributes & FileAttributes.Directory) != 0;
                using var target = WindowsAclHandle.Open(
                    current,
                    0,
                    requireDirectory: isDirectory,
                    "writable_tree_object_missing");
                if (!isDirectory)
                {
                    if (target.LinkCount > 1)
                    {
                        throw new SetupException("writable_tree_hardlink_unsupported");
                    }
                    continue;
                }
                string[] children;
                try
                {
                    children = Directory.GetFileSystemEntries(target.Path);
                }
                catch (Exception error) when (error is UnauthorizedAccessException or IOException)
                {
                    throw new SetupException("writable_tree_enumeration_failed", error);
                }
                foreach (var child in children) pending.Push(Path.GetFullPath(child));
            }
        }
    }
}
