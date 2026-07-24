using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal static class WindowsAccountLogonPolicy
{
    internal const string BatchLogonRight = "SeBatchLogonRight";
    internal const string DenyInteractiveLogonRight = "SeDenyInteractiveLogonRight";
    internal const string DenyRemoteInteractiveLogonRight = "SeDenyRemoteInteractiveLogonRight";
    private const uint PolicyLookupNames = 0x00000800;
    private const uint PolicyCreateAccount = 0x00000010;
    private const int StatusObjectNameNotFound = unchecked((int)0xC0000034);

    private static readonly string[] RequiredRights =
    [
        BatchLogonRight,
        DenyInteractiveLogonRight,
        DenyRemoteInteractiveLogonRight,
    ];

    internal static void Apply(DesiredPolicy policy)
    {
        Apply(ResolveSid(policy.OfflineUser));
        Apply(ResolveSid(policy.OnlineUser));
    }

    internal static bool Verify(DesiredPolicy policy) =>
        Verify(ResolveSid(policy.OfflineUser)) && Verify(ResolveSid(policy.OnlineUser));

    internal static bool HasRequiredRights(IEnumerable<string> rights)
    {
        var actual = rights.ToHashSet(StringComparer.OrdinalIgnoreCase);
        return RequiredRights.All(actual.Contains);
    }

    private static void Apply(SecurityIdentifier sid)
    {
        using var policy = OpenPolicy(PolicyLookupNames | PolicyCreateAccount);
        var sidBytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(sidBytes, 0);
        var sidHandle = GCHandle.Alloc(sidBytes, GCHandleType.Pinned);
        using var rights = LsaUnicodeStringArray.Create(RequiredRights);
        try
        {
            var status = LsaAddAccountRights(
                policy,
                sidHandle.AddrOfPinnedObject(),
                rights.Pointer,
                checked((uint)RequiredRights.Length));
            if (status != 0) ThrowLsa("managed_account_logon_policy_apply_failed", status);
        }
        finally
        {
            sidHandle.Free();
        }
    }

    private static bool Verify(SecurityIdentifier sid)
    {
        using var policy = OpenPolicy(PolicyLookupNames);
        var sidBytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(sidBytes, 0);
        var sidHandle = GCHandle.Alloc(sidBytes, GCHandleType.Pinned);
        IntPtr buffer = IntPtr.Zero;
        try
        {
            var status = LsaEnumerateAccountRights(
                policy,
                sidHandle.AddrOfPinnedObject(),
                out buffer,
                out var count);
            if (status == StatusObjectNameNotFound) return false;
            if (status != 0) ThrowLsa("managed_account_logon_policy_verify_failed", status);
            if (count > 256) throw new SetupException("managed_account_logon_policy_rights_limit_exceeded");
            var rights = new List<string>(checked((int)count));
            var size = Marshal.SizeOf<LsaUnicodeString>();
            for (var index = 0; index < count; index++)
            {
                var value = Marshal.PtrToStructure<LsaUnicodeString>(buffer + checked((int)index * size));
                if (value.Length == 0 || value.Buffer == IntPtr.Zero) continue;
                rights.Add(Marshal.PtrToStringUni(value.Buffer, value.Length / sizeof(char)) ?? string.Empty);
            }
            return HasRequiredRights(rights);
        }
        finally
        {
            if (buffer != IntPtr.Zero) _ = LsaFreeMemory(buffer);
            sidHandle.Free();
        }
    }

    private static SafeLsaPolicyHandle OpenPolicy(uint access)
    {
        var attributes = new LsaObjectAttributes { Length = Marshal.SizeOf<LsaObjectAttributes>() };
        var status = LsaOpenPolicy(IntPtr.Zero, ref attributes, access, out var policy);
        if (status != 0) ThrowLsa("managed_account_logon_policy_open_failed", status);
        return policy;
    }

    private static SecurityIdentifier ResolveSid(string name) =>
        (SecurityIdentifier)new NTAccount(Environment.MachineName, name).Translate(typeof(SecurityIdentifier));

    private static void ThrowLsa(string code, int status) =>
        throw new SetupException(code, new Win32Exception(checked((int)LsaNtStatusToWinError(status))));

    [StructLayout(LayoutKind.Sequential)]
    private struct LsaObjectAttributes
    {
        internal int Length;
        internal IntPtr RootDirectory;
        internal IntPtr ObjectName;
        internal uint Attributes;
        internal IntPtr SecurityDescriptor;
        internal IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LsaUnicodeString
    {
        internal ushort Length;
        internal ushort MaximumLength;
        internal IntPtr Buffer;
    }

    private sealed class LsaUnicodeStringArray : IDisposable
    {
        private IntPtr pointer;
        private readonly IntPtr[] strings;

        private LsaUnicodeStringArray(IntPtr pointer, IntPtr[] strings)
        {
            this.pointer = pointer;
            this.strings = strings;
        }

        internal IntPtr Pointer => pointer;

        internal static LsaUnicodeStringArray Create(IReadOnlyList<string> values)
        {
            var size = Marshal.SizeOf<LsaUnicodeString>();
            var array = Marshal.AllocHGlobal(checked(size * values.Count));
            var strings = new IntPtr[values.Count];
            try
            {
                for (var index = 0; index < values.Count; index++)
                {
                    var value = values[index];
                    var bytes = checked(value.Length * sizeof(char));
                    strings[index] = Marshal.StringToHGlobalUni(value);
                    Marshal.StructureToPtr(new LsaUnicodeString
                    {
                        Length = checked((ushort)bytes),
                        MaximumLength = checked((ushort)(bytes + sizeof(char))),
                        Buffer = strings[index],
                    }, array + checked(index * size), fDeleteOld: false);
                }
                return new LsaUnicodeStringArray(array, strings);
            }
            catch
            {
                foreach (var value in strings)
                {
                    if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
                }
                Marshal.FreeHGlobal(array);
                throw;
            }
        }

        public void Dispose()
        {
            foreach (var value in strings)
            {
                if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
            }
            if (pointer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(pointer);
                pointer = IntPtr.Zero;
            }
        }
    }

    private sealed class SafeLsaPolicyHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeLsaPolicyHandle() : base(ownsHandle: true) { }

        protected override bool ReleaseHandle() => LsaClose(handle) == 0;
    }

    [DllImport("Advapi32.dll")]
    private static extern int LsaOpenPolicy(
        IntPtr systemName,
        ref LsaObjectAttributes objectAttributes,
        uint desiredAccess,
        out SafeLsaPolicyHandle policyHandle);

    [DllImport("Advapi32.dll")]
    private static extern int LsaAddAccountRights(
        SafeLsaPolicyHandle policyHandle,
        IntPtr accountSid,
        IntPtr userRights,
        uint countOfRights);

    [DllImport("Advapi32.dll")]
    private static extern int LsaEnumerateAccountRights(
        SafeLsaPolicyHandle policyHandle,
        IntPtr accountSid,
        out IntPtr userRights,
        out uint countOfRights);

    [DllImport("Advapi32.dll")]
    private static extern int LsaFreeMemory(IntPtr buffer);

    [DllImport("Advapi32.dll")]
    private static extern int LsaClose(IntPtr policyHandle);

    [DllImport("Advapi32.dll")]
    private static extern uint LsaNtStatusToWinError(int status);
}
