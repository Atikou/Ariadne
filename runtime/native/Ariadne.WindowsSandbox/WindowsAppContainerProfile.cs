using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsAppContainerProfile : IDisposable
{
    internal const string InternetClientCapabilityName = "internetClient";
    private const int ErrorAlreadyExistsHResult = unchecked((int)0x800700B7);
    private const int ErrorFileNotFoundHResult = unchecked((int)0x80070002);
    private const int ErrorNotFoundHResult = unchecked((int)0x80070490);
    private readonly string moniker;
    private bool disposed;

    private WindowsAppContainerProfile(
        string moniker,
        SecurityIdentifier packageSid,
        IReadOnlyList<SecurityIdentifier> capabilities)
    {
        this.moniker = moniker;
        PackageSid = packageSid;
        Capabilities = capabilities;
    }

    internal SecurityIdentifier PackageSid { get; }
    internal IReadOnlyList<SecurityIdentifier> Capabilities { get; }

    internal static SecurityIdentifier DeriveFilesystemCapability(
        DesiredPolicy policy,
        SecurityIdentifier ownerSid)
    {
        var identity = string.Join('\0', policy.StateRoot, policy.WorkspaceRoot, policy.Digest, ownerSid.Value);
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
        return DeriveCapabilitySid($"Ariadne.filesystem.{digest[..32]}");
    }

    internal static WindowsAppContainerProfile CreateEphemeral(
        string executionId,
        SecurityIdentifier filesystemCapability,
        bool networkEnabled)
    {
        var moniker = EphemeralMoniker(executionId, filesystemCapability);
        var capabilities = new List<SecurityIdentifier> { filesystemCapability };
        if (networkEnabled) capabilities.Add(DeriveCapabilitySid(InternetClientCapabilityName));

        using var nativeCapabilities = UnmanagedSidSet.Create(capabilities);
        var entries = nativeCapabilities.Pointers
            .Select(pointer => new SidAndAttributes { Sid = pointer, Attributes = 0x00000004 })
            .ToArray();
        var result = CreateAppContainerProfile(
            moniker,
            "Ariadne task sandbox",
            "Ephemeral Ariadne command isolation profile",
            entries,
            checked((uint)entries.Length),
            out var packageSidPointer);
        if (result == ErrorAlreadyExistsHResult)
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "ephemeral AppContainer profile identity collided");
        }
        if (result < 0)
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "CreateAppContainerProfile failed",
                innerException: new ExternalException("CreateAppContainerProfile failed", result));
        }
        if (packageSidPointer == IntPtr.Zero)
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "CreateAppContainerProfile returned no package SID");
        }
        try
        {
            return new WindowsAppContainerProfile(
                moniker,
                new SecurityIdentifier(packageSidPointer),
                capabilities);
        }
        finally
        {
            _ = FreeSid(packageSidPointer);
        }
    }

    internal static SecurityIdentifier DeriveCapabilitySid(string capabilityName)
    {
        if (!DeriveCapabilitySidsFromName(
                capabilityName,
                out var groupArray,
                out var groupCount,
                out var capabilityArray,
                out var capabilityCount))
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "DeriveCapabilitySidsFromName failed",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
        try
        {
            if (capabilityCount != 1 || capabilityArray == IntPtr.Zero)
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "capability derivation returned an invalid SID set");
            }
            var sid = Marshal.ReadIntPtr(capabilityArray);
            if (sid == IntPtr.Zero)
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "capability derivation returned an empty SID");
            }
            return new SecurityIdentifier(sid);
        }
        finally
        {
            FreeSidArray(groupArray, groupCount);
            FreeSidArray(capabilityArray, capabilityCount);
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        DeleteEphemeral(moniker);
    }

    internal static void DeleteEphemeral(
        string executionId,
        SecurityIdentifier filesystemCapability) =>
        DeleteEphemeral(EphemeralMoniker(executionId, filesystemCapability));

    private static string EphemeralMoniker(
        string executionId,
        SecurityIdentifier filesystemCapability)
    {
        var identity = $"{executionId}\0{filesystemCapability.Value}";
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
        return $"Ariadne.Run.{digest[..48]}";
    }

    private static void DeleteEphemeral(string profileMoniker)
    {
        var result = DeleteAppContainerProfile(profileMoniker);
        if (result < 0 && result is not ErrorFileNotFoundHResult and not ErrorNotFoundHResult)
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "DeleteAppContainerProfile failed",
                innerException: new ExternalException("DeleteAppContainerProfile failed", result));
        }
    }

    private static void FreeSidArray(IntPtr array, uint count)
    {
        if (array == IntPtr.Zero) return;
        for (var index = 0u; index < count; index++)
        {
            var sid = Marshal.ReadIntPtr(array, checked((int)index * IntPtr.Size));
            if (sid != IntPtr.Zero) _ = LocalFree(sid);
        }
        _ = LocalFree(array);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        internal IntPtr Sid;
        internal uint Attributes;
    }

    private sealed class UnmanagedSidSet : IDisposable
    {
        private UnmanagedSidSet(IReadOnlyList<IntPtr> pointers)
        {
            Pointers = pointers;
        }

        internal IReadOnlyList<IntPtr> Pointers { get; }

        internal static UnmanagedSidSet Create(IEnumerable<SecurityIdentifier> sids)
        {
            var pointers = new List<IntPtr>();
            try
            {
                foreach (var sid in sids)
                {
                    var bytes = new byte[sid.BinaryLength];
                    sid.GetBinaryForm(bytes, 0);
                    var pointer = Marshal.AllocHGlobal(bytes.Length);
                    Marshal.Copy(bytes, 0, pointer, bytes.Length);
                    pointers.Add(pointer);
                }
                return new UnmanagedSidSet(pointers);
            }
            catch
            {
                foreach (var pointer in pointers) Marshal.FreeHGlobal(pointer);
                throw;
            }
        }

        public void Dispose()
        {
            foreach (var pointer in Pointers) Marshal.FreeHGlobal(pointer);
        }
    }

    [DllImport("Userenv.dll", EntryPoint = "CreateAppContainerProfile", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string appContainerName,
        string displayName,
        string description,
        [In] SidAndAttributes[] capabilities,
        uint capabilityCount,
        out IntPtr appContainerSid);

    [DllImport("Userenv.dll", EntryPoint = "DeleteAppContainerProfile", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string appContainerName);

    [DllImport("KernelBase.dll", EntryPoint = "DeriveCapabilitySidsFromName", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeriveCapabilitySidsFromName(
        string capabilityName,
        out IntPtr capabilityGroupSids,
        out uint capabilityGroupSidCount,
        out IntPtr capabilitySids,
        out uint capabilitySidCount);

    [DllImport("Advapi32.dll")]
    private static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("Kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
