using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsPrivateDesktop : IDisposable
{
    private const int GenericAll = unchecked((int)0x10000000);
    private const uint DesktopAllAccess = 0x000F01FF;
    private const uint WindowStationAllAccess = 0x000F037F;
    private const int UoiName = 2;

    private readonly SafeDesktopHandle handle;
    private readonly SafeWindowStationHandle station;
    private readonly IntPtr previousStation;
    private bool disposed;

    private WindowsPrivateDesktop(
        SafeDesktopHandle handle,
        SafeWindowStationHandle station,
        IntPtr previousStation,
        SecurityIdentifier restrictionSid,
        string startupName)
    {
        this.handle = handle;
        this.station = station;
        this.previousStation = previousStation;
        RestrictionSid = restrictionSid;
        StartupName = startupName;
    }

    internal SecurityIdentifier RestrictionSid { get; }
    internal string StartupName { get; }

    internal static WindowsPrivateDesktop Create(SecurityIdentifier appContainerSid)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var userSid = identity.User ?? throw new NativeExecutionException(
            "process_start_failure",
            "runner token has no user SID for private desktop");
        var restrictionSid = WindowsCapabilitySid.Create();
        var previousStation = GetProcessWindowStation();
        if (previousStation == IntPtr.Zero) throw Failure("GetProcessWindowStation failed");
        using var stationDescriptor = NativeSecurityDescriptor.Create(
            CreateDescriptor(userSid, restrictionSid, appContainerSid));
        var stationAttributes = stationDescriptor.CreateAttributes();
        var station = CreateWindowStation(
            null,
            0,
            WindowStationAllAccess,
            ref stationAttributes);
        if (station.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            station.Dispose();
            throw Failure("CreateWindowStationW failed", error);
        }
        if (!SetProcessWindowStation(station.DangerousGetHandle()))
        {
            var error = Marshal.GetLastWin32Error();
            station.Dispose();
            throw Failure("SetProcessWindowStation(private) failed", error);
        }
        try
        {
            var stationName = UserObjectName(station.DangerousGetHandle());
            var desktopName = $"AriadneDesktop-{Guid.NewGuid():N}";
            using var desktopDescriptor = NativeSecurityDescriptor.Create(
                CreateDescriptor(userSid, restrictionSid, appContainerSid));
            var desktopAttributes = desktopDescriptor.CreateAttributes();
            var desktop = CreateDesktop(
                desktopName,
                null,
                IntPtr.Zero,
                0,
                DesktopAllAccess,
                ref desktopAttributes);
            if (desktop.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                desktop.Dispose();
                throw Failure("CreateDesktopW failed", error);
            }
            return new WindowsPrivateDesktop(
                desktop,
                station,
                previousStation,
                restrictionSid,
                $"{stationName}\\{desktopName}");
        }
        catch
        {
            _ = SetProcessWindowStation(previousStation);
            station.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        handle.Dispose();
        var restored = SetProcessWindowStation(previousStation);
        var error = restored ? 0 : Marshal.GetLastWin32Error();
        station.Dispose();
        if (!restored) throw Failure("SetProcessWindowStation(previous) failed", error);
    }

    private static byte[] CreateDescriptor(params SecurityIdentifier[] sourceSids)
    {
        var sids = sourceSids.Distinct().ToArray();
        var acl = new RawAcl(GenericAcl.AclRevision, sids.Length);
        foreach (var sid in sids) AddCapabilityAce(acl, sid);
        var descriptor = new RawSecurityDescriptor(
            ControlFlags.DiscretionaryAclPresent,
            sids[0],
            group: null,
            systemAcl: null,
            discretionaryAcl: acl);
        var bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        return bytes;
    }

    private static void AddCapabilityAce(RawAcl acl, SecurityIdentifier sid) =>
        acl.InsertAce(
            acl.Count,
            new CommonAce(
                AceFlags.None,
                AceQualifier.AccessAllowed,
                GenericAll,
                sid,
                isCallback: false,
                opaque: null));

    private static string UserObjectName(IntPtr handle)
    {
        _ = GetUserObjectInformation(handle, UoiName, null, 0, out var required);
        if (required <= sizeof(char)) throw Failure("GetUserObjectInformation(window station) size failed");
        var buffer = new StringBuilder(checked((int)(required / sizeof(char))));
        if (!GetUserObjectInformation(handle, UoiName, buffer, required, out _))
        {
            throw Failure("GetUserObjectInformation(window station) failed");
        }
        var result = buffer.ToString();
        if (string.IsNullOrWhiteSpace(result))
        {
            throw new NativeExecutionException("process_start_failure", "window station has no name");
        }
        return result;
    }

    private static NativeExecutionException Failure(string message) => new(
        "process_start_failure",
        message,
        innerException: new Win32Exception(Marshal.GetLastWin32Error()));

    private static NativeExecutionException Failure(string message, int error) => new(
        "process_start_failure",
        message,
        innerException: new Win32Exception(error));

    private sealed class NativeSecurityDescriptor : IDisposable
    {
        private IntPtr pointer;

        private NativeSecurityDescriptor(IntPtr pointer)
        {
            this.pointer = pointer;
        }

        internal static NativeSecurityDescriptor Create(byte[] descriptor)
        {
            var pointer = Marshal.AllocHGlobal(descriptor.Length);
            Marshal.Copy(descriptor, 0, pointer, descriptor.Length);
            return new NativeSecurityDescriptor(pointer);
        }

        internal SecurityAttributes CreateAttributes() => new()
        {
            Length = Marshal.SizeOf<SecurityAttributes>(),
            SecurityDescriptor = pointer,
            InheritHandle = false,
        };

        public void Dispose()
        {
            if (pointer == IntPtr.Zero) return;
            Marshal.FreeHGlobal(pointer);
            pointer = IntPtr.Zero;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
    }

    private sealed class SafeDesktopHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeDesktopHandle() : base(ownsHandle: true) { }

        protected override bool ReleaseHandle() => CloseDesktop(handle);
    }

    private sealed class SafeWindowStationHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeWindowStationHandle() : base(ownsHandle: true) { }

        protected override bool ReleaseHandle() => CloseWindowStation(handle);
    }

    [DllImport("User32.dll", EntryPoint = "CreateWindowStationW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeWindowStationHandle CreateWindowStation(
        string? windowStation,
        uint flags,
        uint desiredAccess,
        ref SecurityAttributes securityAttributes);

    [DllImport("User32.dll", EntryPoint = "CreateDesktopW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeDesktopHandle CreateDesktop(
        string desktop,
        string? device,
        IntPtr deviceMode,
        uint flags,
        uint desiredAccess,
        ref SecurityAttributes securityAttributes);

    [DllImport("User32.dll")]
    private static extern IntPtr GetProcessWindowStation();

    [DllImport("User32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformation(
        IntPtr handle,
        int index,
        StringBuilder? information,
        uint length,
        out uint needed);

    [DllImport("User32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessWindowStation(IntPtr windowStation);

    [DllImport("User32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("User32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseWindowStation(IntPtr windowStation);
}
