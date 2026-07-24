using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsRuntimeDirectory : IDisposable
{
    private readonly string directoryPath;
    private bool disposed;

    private WindowsRuntimeDirectory(
        string directoryPath,
        SecurityIdentifier restrictionSid,
        string roamingAppData,
        string localAppData)
    {
        this.directoryPath = directoryPath;
        RestrictionSid = restrictionSid;
        RoamingAppData = roamingAppData;
        LocalAppData = localAppData;
    }

    internal string Path => directoryPath;
    internal SecurityIdentifier RestrictionSid { get; }
    internal string RoamingAppData { get; }
    internal string LocalAppData { get; }

    internal static WindowsRuntimeDirectory Create(
        string executionId,
        SecurityIdentifier filesystemCapability,
        SecurityIdentifier appContainerSid)
    {
        var directoryPath = EphemeralPath(System.IO.Path.GetTempPath(), executionId, filesystemCapability);
        if (Directory.Exists(directoryPath) || File.Exists(directoryPath))
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "ephemeral runtime directory identity collided");
        }
        var directory = Directory.CreateDirectory(directoryPath);
        try
        {
            if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "runtime directory is a reparse point");
            }
            using var identity = WindowsIdentity.GetCurrent();
            var userSid = identity.User ?? throw new NativeExecutionException(
                "process_start_failure",
                "runner token has no user SID for runtime directory");
            var restrictionSid = WindowsCapabilitySid.Create();
            var security = new DirectorySecurity();
            security.SetOwner(userSid);
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            AddRule(security, userSid, FileSystemRights.FullControl);
            AddRule(
                security,
                restrictionSid,
                FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize);
            AddRule(
                security,
                appContainerSid,
                FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize);
            directory.SetAccessControl(security);
            var roamingAppData = System.IO.Path.Combine(directory.FullName, "AppData", "Roaming");
            var localAppData = System.IO.Path.Combine(directory.FullName, "AppData", "Local");
            Directory.CreateDirectory(roamingAppData);
            Directory.CreateDirectory(localAppData);
            return new WindowsRuntimeDirectory(
                directory.FullName,
                restrictionSid,
                roamingAppData,
                localAppData);
        }
        catch
        {
            DeleteTree(directoryPath);
            throw;
        }
    }

    internal static void DeleteEphemeral(
        string tempRoot,
        string executionId,
        SecurityIdentifier filesystemCapability) =>
        DeleteTree(EphemeralPath(tempRoot, executionId, filesystemCapability));

    internal static string EphemeralPath(
        string tempRoot,
        string executionId,
        SecurityIdentifier filesystemCapability)
    {
        var identity = $"{executionId}\0{filesystemCapability.Value}";
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
        return System.IO.Path.Combine(
            System.IO.Path.GetFullPath(tempRoot),
            $"Ariadne-Run-{digest[..48]}");
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        DeleteTree(directoryPath);
    }

    private static void AddRule(
        DirectorySecurity security,
        SecurityIdentifier sid,
        FileSystemRights rights) =>
        security.AddAccessRule(new FileSystemAccessRule(
            sid,
            rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));

    private static void DeleteTree(string rootPath)
    {
        FileAttributes rootAttributes;
        try
        {
            rootAttributes = File.GetAttributes(rootPath);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return;
        }
        if ((rootAttributes & FileAttributes.ReparsePoint) != 0)
        {
            DeleteEntry(rootPath, rootAttributes);
            return;
        }
        foreach (var entryPath in Directory.EnumerateFileSystemEntries(rootPath))
        {
            var attributes = File.GetAttributes(entryPath);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                DeleteEntry(entryPath, attributes);
                continue;
            }
            if ((attributes & FileAttributes.Directory) != 0) DeleteTree(entryPath);
            else
            {
                File.SetAttributes(entryPath, attributes & ~FileAttributes.ReadOnly);
                File.Delete(entryPath);
            }
        }
        Directory.Delete(rootPath);
    }

    private static void DeleteEntry(string path, FileAttributes attributes)
    {
        if ((attributes & FileAttributes.Directory) != 0)
        {
            Directory.Delete(path);
            return;
        }
        if ((attributes & FileAttributes.ReparsePoint) == 0)
        {
            File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
        }
        File.Delete(path);
    }
}
