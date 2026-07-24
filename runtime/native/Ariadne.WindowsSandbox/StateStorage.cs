using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Ariadne.WindowsSandbox;

internal static class StateStorage
{
    internal const string ManifestFileName = "setup-manifest.json";
    internal const string VaultFileName = "credential-vault.json";
    internal const string ArtifactLeaseFileName = "sandbox-artifact-leases.json";
    private static readonly HashSet<string> OwnedFileNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ManifestFileName,
        VaultFileName,
        ArtifactLeaseFileName,
    };
    private const FileSystemRights OwnerMutationRights =
        FileSystemRights.Write |
        FileSystemRights.Delete |
        FileSystemRights.DeleteSubdirectoriesAndFiles |
        FileSystemRights.ChangePermissions |
        FileSystemRights.TakeOwnership;

    internal static void PrepareRoot(string stateRoot, SecurityIdentifier ownerSid)
    {
        var boundary = GetProgramDataBoundary();
        Directory.CreateDirectory(boundary);
        ApplyDirectoryAcl(boundary, ownerSid);
        if (Directory.Exists(stateRoot))
        {
            EnsureOwnedEntries(stateRoot);
        }
        else
        {
            Directory.CreateDirectory(stateRoot);
        }
        ApplyDirectoryAcl(stateRoot, ownerSid);
        EnsureOwnedEntries(stateRoot);
    }

    internal static void ValidateSecureRootLocation(string stateRoot)
    {
        var boundary = GetProgramDataBoundary();
        if (!PathPolicy.IsSameOrDescendant(stateRoot, boundary))
        {
            throw new SetupException("state_root_must_be_under_program_data");
        }
    }

    internal static bool VerifyRoot(string stateRoot, SecurityIdentifier ownerSid)
    {
        var boundary = GetProgramDataBoundary();
        return VerifyDirectory(boundary, ownerSid) && VerifyDirectory(stateRoot, ownerSid);
    }

    private static bool VerifyDirectory(string path, SecurityIdentifier ownerSid)
    {
        if (!Directory.Exists(path)) return false;
        using var target = WindowsAclHandle.Open(
            path,
            AclHandleAccess.ReadControl,
            requireDirectory: true,
            "state_directory_missing");
        var security = target.ReadSecurity(AccessControlSections.Access | AccessControlSections.Owner);
        var administratorsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        if (!security.AreAccessRulesProtected || !administratorsSid.Equals(security.GetOwner(typeof(SecurityIdentifier))))
        {
            return false;
        }
        var allowed = new Dictionary<string, FileSystemRights>(StringComparer.Ordinal)
        {
            [ownerSid.Value] = FileSystemRights.ReadAndExecute,
            [new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value] = FileSystemRights.FullControl,
            [administratorsSid.Value] = FileSystemRights.FullControl,
        };
        var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .ToArray();
        if (rules.Any(rule =>
                rule.AccessControlType != AccessControlType.Allow ||
                !allowed.ContainsKey(rule.IdentityReference.Value) ||
                rule.IdentityReference.Value == ownerSid.Value &&
                (rule.FileSystemRights & OwnerMutationRights) != 0))
        {
            return false;
        }
        return allowed.All(entry => rules.Any(rule =>
            rule.AccessControlType == AccessControlType.Allow &&
            rule.IdentityReference.Value == entry.Key &&
            (rule.FileSystemRights & entry.Value) == entry.Value &&
            (rule.InheritanceFlags & (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit)) ==
                (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) &&
            rule.PropagationFlags == PropagationFlags.None));
    }

    internal static bool VerifyFile(string path, SecurityIdentifier ownerSid)
    {
        if (!File.Exists(path)) return false;
        using var target = WindowsAclHandle.Open(
            path,
            AclHandleAccess.ReadControl,
            requireDirectory: false,
            "state_file_missing");
        var security = target.ReadSecurity(AccessControlSections.Access | AccessControlSections.Owner);
        var administratorsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        if (!security.AreAccessRulesProtected || !administratorsSid.Equals(security.GetOwner(typeof(SecurityIdentifier))))
        {
            return false;
        }
        var expected = new Dictionary<string, FileSystemRights>(StringComparer.Ordinal)
        {
            [ownerSid.Value] = FileSystemRights.Read,
            [new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value] = FileSystemRights.FullControl,
            [administratorsSid.Value] = FileSystemRights.FullControl,
        };
        var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .ToArray();
        return rules.All(rule =>
                rule.AccessControlType == AccessControlType.Allow &&
                expected.ContainsKey(rule.IdentityReference.Value) &&
                (rule.IdentityReference.Value != ownerSid.Value ||
                 (rule.FileSystemRights & OwnerMutationRights) == 0)) &&
            expected.All(entry => rules.Any(rule =>
                rule.AccessControlType == AccessControlType.Allow &&
                rule.IdentityReference.Value == entry.Key &&
                (rule.FileSystemRights & entry.Value) == entry.Value &&
                rule.InheritanceFlags == InheritanceFlags.None &&
                rule.PropagationFlags == PropagationFlags.None));
    }

    internal static void WriteJsonAtomic<T>(string stateRoot, string fileName, T value, SecurityIdentifier ownerSid)
    {
        if (!OwnedFileNames.Contains(fileName))
        {
            throw new SetupException("state_file_name_not_owned");
        }
        var target = Path.Combine(stateRoot, fileName);
        var temporary = Path.Combine(stateRoot, $".{fileName}.{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(value, JsonProtocol.Options));
            ApplyFileAcl(temporary, ownerSid);
            File.Move(temporary, target, true);
            ApplyFileAcl(target, ownerSid);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    internal static T? ReadJson<T>(string stateRoot, string fileName, long maxBytes) where T : class
    {
        var target = Path.Combine(stateRoot, fileName);
        if (!File.Exists(target)) return null;
        if (new FileInfo(target).Length > maxBytes)
        {
            throw new SetupException("state_file_too_large");
        }
        return JsonSerializer.Deserialize<T>(File.ReadAllText(target), JsonProtocol.Options);
    }

    internal static void ApplyDirectoryAcl(string path, SecurityIdentifier ownerSid)
    {
        var administratorsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(administratorsSid);
        AddDirectoryRule(security, ownerSid, FileSystemRights.ReadAndExecute);
        AddDirectoryRule(security, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl);
        AddDirectoryRule(security, administratorsSid, FileSystemRights.FullControl);
        using var target = WindowsAclHandle.Open(
            path,
            AclHandleAccess.WriteDacl | AclHandleAccess.WriteOwner,
            requireDirectory: true,
            "state_directory_missing");
        target.WriteSecurity(security, setOwner: true, setDaclProtection: true);
    }

    internal static void ApplyFileAcl(string path, SecurityIdentifier ownerSid)
    {
        var administratorsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var security = new FileSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(administratorsSid);
        security.AddAccessRule(new FileSystemAccessRule(ownerSid, FileSystemRights.Read, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl,
            AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(administratorsSid, FileSystemRights.FullControl, AccessControlType.Allow));
        using var target = WindowsAclHandle.Open(
            path,
            AclHandleAccess.WriteDacl | AclHandleAccess.WriteOwner,
            requireDirectory: false,
            "state_file_missing");
        target.WriteSecurity(security, setOwner: true, setDaclProtection: true);
    }

    internal static void ApplyExchangeDirectoryAcl(string path, SecurityIdentifier ownerSid)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(ownerSid);
        AddDirectoryRule(security, ownerSid, FileSystemRights.FullControl);
        AddDirectoryRule(security, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl);
        AddDirectoryRule(security, new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl);
        using var target = WindowsAclHandle.Open(
            path,
            AclHandleAccess.WriteDacl | AclHandleAccess.WriteOwner,
            requireDirectory: true,
            "elevation_exchange_missing");
        target.WriteSecurity(security, setOwner: true, setDaclProtection: true);
    }

    internal static void ApplyExchangeFileAcl(string path, SecurityIdentifier ownerSid)
    {
        var security = new FileSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(ownerSid);
        foreach (var sid in new[]
                 {
                     ownerSid,
                     new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                     new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                 })
        {
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        }
        using var target = WindowsAclHandle.Open(
            path,
            AclHandleAccess.WriteDacl | AclHandleAccess.WriteOwner,
            requireDirectory: false,
            "elevation_exchange_missing");
        target.WriteSecurity(security, setOwner: true, setDaclProtection: true);
    }

    private static void AddDirectoryRule(DirectorySecurity security, SecurityIdentifier sid, FileSystemRights rights)
    {
        security.AddAccessRule(new FileSystemAccessRule(
            sid,
            rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
    }

    private static void EnsureOwnedEntries(string stateRoot)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(stateRoot))
        {
            var name = Path.GetFileName(entry);
            if (name is null || !OwnedFileNames.Contains(name) || !File.Exists(entry) || Directory.Exists(entry))
            {
                throw new SetupException("state_root_contains_foreign_data");
            }
        }
    }

    private static string GetProgramDataBoundary()
    {
        var commonData = WindowsPathResolver.Canonicalize(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
        return Path.Combine(commonData, "Ariadne");
    }
}
