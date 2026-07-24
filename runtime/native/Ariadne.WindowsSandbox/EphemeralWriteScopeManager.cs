using System.Buffers.Binary;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Ariadne.WindowsSandbox;

internal static class EphemeralWriteScopeManager
{
    private const int MaxScopeObjects = 100_000;
    private static readonly string[] RuntimeSegments = [".ariadne", "runtime", "subagent-workspaces"];

    internal static WriteScopeAuthorization Prepare(
        WriteScopeRequest request,
        DesiredPolicy policy,
        SetupManifest manifest,
        SecurityIdentifier ownerSid)
    {
        var scopeRoot = PathPolicy.NormalizeAbsolute(request.Root, "writeScope.root");
        ValidateTrustedLocation(request.ScopeId, scopeRoot, policy);
        var capabilitySid = DeriveCapabilitySid(request.ScopeId, scopeRoot);
        try
        {
            ApplyScopeRules(
                scopeRoot,
                ownerSid,
                new SecurityIdentifier(manifest.OfflineUserSid),
                new SecurityIdentifier(manifest.OnlineUserSid),
                new SecurityIdentifier(manifest.WriterGroupSid),
                capabilitySid);
        }
        catch (Exception error) when (error is SetupException or IOException or UnauthorizedAccessException)
        {
            throw new NativeExecutionException(
                "process_start_failure",
                $"write_scope_acl_prepare_failed:{(error as SetupException)?.Code ?? error.GetType().Name}",
                innerException: error);
        }
        return new WriteScopeAuthorization(request.ScopeId, scopeRoot, capabilitySid.Value);
    }

    internal static SecurityIdentifier DeriveCapabilitySid(string scopeId, string scopeRoot)
    {
        var normalizedRoot = Path.GetFullPath(scopeRoot).Replace('/', '\\').ToUpperInvariant();
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes($"{scopeId}\0{normalizedRoot}"));
        return new SecurityIdentifier(
            $"S-1-5-21-{BinaryPrimitives.ReadUInt32LittleEndian(digest.AsSpan(0, 4))}" +
            $"-{BinaryPrimitives.ReadUInt32LittleEndian(digest.AsSpan(4, 4))}" +
            $"-{BinaryPrimitives.ReadUInt32LittleEndian(digest.AsSpan(8, 4))}" +
            $"-{BinaryPrimitives.ReadUInt32LittleEndian(digest.AsSpan(12, 4))}");
    }

    private static void ValidateTrustedLocation(
        string scopeId,
        string scopeRoot,
        DesiredPolicy policy)
    {
        var runtimeRoot = Path.Combine(policy.WorkspaceRoot, Path.Combine(RuntimeSegments));
        var repositoryName = Path.GetFileName(scopeRoot.TrimEnd(Path.DirectorySeparatorChar));
        var scopeContainer = Directory.GetParent(scopeRoot);
        if (scopeContainer is null ||
            !string.Equals(repositoryName, "repository", StringComparison.Ordinal) ||
            !PathPolicy.PathEquals(scopeContainer.Parent?.FullName ?? string.Empty, runtimeRoot) ||
            !scopeContainer.Name.StartsWith($"{scopeId}-", StringComparison.Ordinal) ||
            scopeContainer.Name.Length <= scopeId.Length + 1)
        {
            throw new RequestException("writeScope.root is not a trusted Ariadne runtime directory");
        }
        if (policy.ReadOnlySubpaths.Any(protectedPath =>
                PathPolicy.IsSameOrDescendant(scopeRoot, protectedPath) ||
                PathPolicy.IsSameOrDescendant(protectedPath, scopeRoot)))
        {
            throw new RequestException("writeScope.root overlaps a read-only policy path");
        }
    }

    private static void ApplyScopeRules(
        string scopeRoot,
        SecurityIdentifier ownerSid,
        SecurityIdentifier offlineSid,
        SecurityIdentifier onlineSid,
        SecurityIdentifier writerSid,
        SecurityIdentifier capabilitySid)
    {
        var pending = new Stack<string>();
        pending.Push(scopeRoot);
        var visited = 0;
        while (pending.TryPop(out var current))
        {
            visited++;
            if (visited > MaxScopeObjects) throw new SetupException("write_scope_object_limit_exceeded");
            var attributes = ReadAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new SetupException("write_scope_reparse_point_rejected");
            }
            var isDirectory = (attributes & FileAttributes.Directory) != 0;
            using var target = WindowsAclHandle.Open(
                current,
                AclHandleAccess.ReadControl | AclHandleAccess.WriteDacl,
                requireDirectory: isDirectory,
                "write_scope_object_missing");
            if (!isDirectory && target.LinkCount > 1)
            {
                throw new SetupException("write_scope_hardlink_rejected");
            }
            var security = target.ReadSecurity(
                isDirectory && PathPolicy.PathEquals(target.Path, scopeRoot)
                    ? AccessControlSections.Access | AccessControlSections.Owner
                    : AccessControlSections.Access);
            var targetOwner = isDirectory && PathPolicy.PathEquals(target.Path, scopeRoot)
                ? security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier
                : null;
            if (isDirectory && PathPolicy.PathEquals(target.Path, scopeRoot) &&
                (targetOwner is null || !targetOwner.Equals(ownerSid)))
            {
                throw new SetupException("write_scope_owner_mismatch");
            }
            ReplaceRule(security, offlineSid, FileSystemRights.ReadAndExecute, isDirectory);
            ReplaceRule(security, onlineSid, FileSystemRights.ReadAndExecute, isDirectory);
            ReplaceRule(security, writerSid, FileSystemRights.Modify, isDirectory);
            ReplaceRule(security, capabilitySid, FileSystemRights.Modify, isDirectory);
            target.WriteSecurity(security, setOwner: false, setDaclProtection: false);
            VerifyCapabilityRule(target, capabilitySid, isDirectory);

            if (!isDirectory) continue;
            foreach (var child in ReadChildren(target.Path))
            {
                var childPath = Path.GetFullPath(child);
                if (!PathPolicy.IsSameOrDescendant(childPath, scopeRoot) ||
                    PathPolicy.PathEquals(childPath, scopeRoot))
                {
                    throw new SetupException("write_scope_path_escape");
                }
                pending.Push(childPath);
            }
        }
    }

    private static FileAttributes ReadAttributes(string path)
    {
        try
        {
            return File.GetAttributes(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new SetupException("write_scope_attributes_failed", error);
        }
    }

    private static string[] ReadChildren(string path)
    {
        try
        {
            return Directory.GetFileSystemEntries(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new SetupException("write_scope_enumeration_failed", error);
        }
    }

    private static void ReplaceRule(
        FileSystemSecurity security,
        SecurityIdentifier sid,
        FileSystemRights rights,
        bool inherit)
    {
        var directRules = security.GetAccessRules(true, false, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .Where(rule => rule.IdentityReference.Equals(sid) && rule.AccessControlType == AccessControlType.Allow)
            .ToArray();
        foreach (var existing in directRules) security.RemoveAccessRuleSpecific(existing);
        security.AddAccessRule(new FileSystemAccessRule(
            sid,
            rights,
            inherit ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
            PropagationFlags.None,
            AccessControlType.Allow));
    }

    private static void VerifyCapabilityRule(
        WindowsAclHandle target,
        SecurityIdentifier capabilitySid,
        bool inherit)
    {
        var rules = target.ReadSecurity(AccessControlSections.Access)
            .GetAccessRules(true, false, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>();
        var expectedInheritance = inherit
            ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit
            : InheritanceFlags.None;
        if (!rules.Any(rule =>
                rule.IdentityReference.Equals(capabilitySid) &&
                rule.AccessControlType == AccessControlType.Allow &&
                (rule.FileSystemRights & FileSystemRights.Modify) == FileSystemRights.Modify &&
                rule.InheritanceFlags == expectedInheritance))
        {
            throw new SetupException("write_scope_capability_acl_unverified");
        }
    }
}
