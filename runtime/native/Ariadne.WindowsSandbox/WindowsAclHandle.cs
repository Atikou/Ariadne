using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

[Flags]
internal enum AclHandleAccess : uint
{
    ReadControl = 0x00020000,
    WriteDacl = 0x00040000,
    WriteOwner = 0x00080000,
}

internal sealed class WindowsAclHandle : IDisposable
{
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileAttributeDirectory = 0x00000010;
    private const int SeFileObject = 1;
    private const uint OwnerSecurityInformation = 0x00000001;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint ProtectedDaclSecurityInformation = 0x80000000;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;

    private readonly SafeFileHandle handle;

    private WindowsAclHandle(SafeFileHandle handle, string path, bool isDirectory, uint linkCount)
    {
        this.handle = handle;
        Path = path;
        IsDirectory = isDirectory;
        LinkCount = linkCount;
    }

    internal string Path { get; }
    internal bool IsDirectory { get; }
    internal uint LinkCount { get; }

    internal static WindowsAclHandle Open(
        string expectedPath,
        AclHandleAccess access,
        bool? requireDirectory,
        string failureCode)
    {
        var handle = CreateFile(
            expectedPath,
            (uint)access | FileReadAttributes,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new SetupException(
                error is ErrorFileNotFound or ErrorPathNotFound ? failureCode : "acl_handle_open_failed",
                new Win32Exception(error));
        }
        try
        {
            var resolved = WindowsPathResolver.ResolveHandle(handle);
            if (!PathPolicy.PathEquals(resolved, expectedPath))
            {
                throw new SetupException("acl_path_identity_changed");
            }
            if (!GetFileInformationByHandle(handle, out var information))
            {
                throw new SetupException(
                    "acl_handle_information_failed",
                    new Win32Exception(Marshal.GetLastWin32Error()));
            }
            var isDirectory = (information.FileAttributes & FileAttributeDirectory) != 0;
            if (requireDirectory is not null && isDirectory != requireDirectory)
            {
                throw new SetupException(requireDirectory.Value
                    ? "acl_target_not_directory"
                    : "acl_target_not_file");
            }
            return new WindowsAclHandle(handle, resolved, isDirectory, information.NumberOfLinks);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    internal FileSystemSecurity ReadSecurity(AccessControlSections sections)
    {
        EnsureCurrentIdentity();
        var securityInformation = DaclSecurityInformation;
        if ((sections & AccessControlSections.Owner) != 0)
        {
            securityInformation |= OwnerSecurityInformation;
        }
        var result = GetSecurityInfo(
            handle,
            SeFileObject,
            securityInformation,
            out _,
            out _,
            out _,
            out _,
            out var descriptor);
        if (result != 0)
        {
            throw new SetupException("acl_read_failed", new Win32Exception((int)result));
        }
        if (descriptor == IntPtr.Zero)
        {
            throw new SetupException("acl_descriptor_missing");
        }
        try
        {
            var length = GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 1024 * 1024)
            {
                throw new SetupException("acl_descriptor_size_invalid");
            }
            var binary = new byte[length];
            Marshal.Copy(descriptor, binary, 0, binary.Length);
            FileSystemSecurity security = IsDirectory ? new DirectorySecurity() : new FileSecurity();
            security.SetSecurityDescriptorBinaryForm(binary, sections);
            EnsureCurrentIdentity();
            return security;
        }
        finally
        {
            _ = LocalFree(descriptor);
        }
    }

    internal void WriteSecurity(FileSystemSecurity security, bool setOwner, bool setDaclProtection)
    {
        EnsureCurrentIdentity();
        if (security is DirectorySecurity != IsDirectory || security is FileSecurity == IsDirectory)
        {
            throw new SetupException("acl_descriptor_type_mismatch");
        }
        var binary = security.GetSecurityDescriptorBinaryForm();
        var pinned = GCHandle.Alloc(binary, GCHandleType.Pinned);
        try
        {
            var descriptor = pinned.AddrOfPinnedObject();
            if (!GetSecurityDescriptorDacl(descriptor, out var daclPresent, out var dacl, out _) ||
                !daclPresent ||
                dacl == IntPtr.Zero)
            {
                throw new SetupException("acl_descriptor_dacl_invalid");
            }
            var owner = IntPtr.Zero;
            if (setOwner &&
                (!GetSecurityDescriptorOwner(descriptor, out owner, out _) || owner == IntPtr.Zero))
            {
                throw new SetupException("acl_descriptor_owner_invalid");
            }
            var securityInformation = DaclSecurityInformation;
            if (setOwner) securityInformation |= OwnerSecurityInformation;
            if (setDaclProtection && security.AreAccessRulesProtected)
            {
                securityInformation |= ProtectedDaclSecurityInformation;
            }
            var result = SetSecurityInfo(
                handle,
                SeFileObject,
                securityInformation,
                owner,
                IntPtr.Zero,
                dacl,
                IntPtr.Zero);
            if (result != 0)
            {
                throw new SetupException("acl_write_failed", new Win32Exception((int)result));
            }
            EnsureCurrentIdentity();
        }
        finally
        {
            pinned.Free();
        }
    }

    private void EnsureCurrentIdentity()
    {
        if (!PathPolicy.PathEquals(WindowsPathResolver.ResolveHandle(handle), Path))
        {
            throw new SetupException("acl_path_identity_changed");
        }
    }

    public void Dispose() => handle.Dispose();

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [DllImport("Kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation fileInformation);

    [DllImport("Advapi32.dll")]
    private static extern uint GetSecurityInfo(
        SafeFileHandle handle,
        int objectType,
        uint securityInformation,
        out IntPtr owner,
        out IntPtr group,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor);

    [DllImport("Advapi32.dll")]
    private static extern uint SetSecurityInfo(
        SafeFileHandle handle,
        int objectType,
        uint securityInformation,
        IntPtr owner,
        IntPtr group,
        IntPtr dacl,
        IntPtr sacl);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorDacl(
        IntPtr securityDescriptor,
        [MarshalAs(UnmanagedType.Bool)] out bool daclPresent,
        out IntPtr dacl,
        [MarshalAs(UnmanagedType.Bool)] out bool daclDefaulted);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorOwner(
        IntPtr securityDescriptor,
        out IntPtr owner,
        [MarshalAs(UnmanagedType.Bool)] out bool ownerDefaulted);

    [DllImport("Advapi32.dll")]
    private static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);

    [DllImport("Kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
