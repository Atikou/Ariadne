using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsRestrictedToken : IDisposable
{
    private const uint TokenAssignPrimary = 0x0001;
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustPrivileges = 0x0020;
    private const uint TokenAdjustDefault = 0x0080;
    private const uint TokenAdjustSessionId = 0x0100;
    private const uint DisableMaxPrivilege = 0x00000001;
    private const uint LuaToken = 0x00000004;
    private const uint WriteRestricted = 0x00000008;
    private const uint SeGroupLogonId = 0xC0000000;
    private const uint SePrivilegeEnabled = 0x00000002;
    private const int ErrorNotAllAssigned = 1300;
    private const int TokenGroups = 2;
    private const int TokenDefaultDacl = 6;
    private const int TokenRestrictedSids = 11;
    private const int GenericAll = unchecked((int)0x10000000);

    private readonly SafeAccessTokenHandle handle;

    private WindowsRestrictedToken(SafeAccessTokenHandle handle)
    {
        this.handle = handle;
    }

    internal SafeAccessTokenHandle Handle => handle;

    internal static WindowsRestrictedToken Create(params SecurityIdentifier[] capabilitySids)
    {
        var desiredAccess = TokenAssignPrimary |
                            TokenDuplicate |
                            TokenQuery |
                            TokenAdjustPrivileges |
                            TokenAdjustDefault |
                            TokenAdjustSessionId;
        if (!OpenProcessToken(Process.GetCurrentProcess().SafeHandle, desiredAccess, out var sourceToken))
        {
            throw Failure("OpenProcessToken failed");
        }
        using (sourceToken)
        {
            using var currentIdentity = WindowsIdentity.GetCurrent();
            var userSid = currentIdentity.User ?? throw new NativeExecutionException(
                "process_start_failure",
                "runner token has no user SID");
            var logonSid = GetLogonSid(sourceToken);
            if (capabilitySids.Length == 0)
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "restricted token requires at least one capability SID");
            }
            var restrictingSids = capabilitySids
                .Append(userSid)
                .Append(logonSid)
                .Append(new SecurityIdentifier(WellKnownSidType.WorldSid, null))
                .Distinct()
                .ToArray();
            var defaultDaclSids = capabilitySids
                .Append(userSid)
                .Append(logonSid)
                .Distinct()
                .ToArray();
            using var sidSet = UnmanagedSidSet.Create(restrictingSids);
            var entries = sidSet.Pointers
                .Select(pointer => new SidAndAttributes { Sid = pointer, Attributes = 0 })
                .ToArray();
            if (!CreateRestrictedToken(
                    sourceToken,
                    DisableMaxPrivilege | LuaToken | WriteRestricted,
                    0,
                    null,
                    0,
                    IntPtr.Zero,
                    checked((uint)entries.Length),
                    entries,
                    out var restrictedToken))
            {
                throw Failure("CreateRestrictedToken failed");
            }
            try
            {
                SetDefaultDacl(restrictedToken, defaultDaclSids);
                EnablePrivilege(restrictedToken, "SeChangeNotifyPrivilege");
                if (!IsTokenRestricted(restrictedToken) ||
                    restrictingSids.Any(sid => !ContainsRestrictedSid(restrictedToken, sid)))
                {
                    throw new NativeExecutionException(
                        "process_start_failure",
                        "restricted token postcondition failed");
                }
                return new WindowsRestrictedToken(restrictedToken);
            }
            catch
            {
                restrictedToken.Dispose();
                throw;
            }
        }
    }

    public void Dispose() => handle.Dispose();

    private static void SetDefaultDacl(
        SafeAccessTokenHandle token,
        IReadOnlyCollection<SecurityIdentifier> sids)
    {
        var acl = new RawAcl(GenericAcl.AclRevision, sids.Count);
        foreach (var sid in sids)
        {
            acl.InsertAce(
                acl.Count,
                new CommonAce(
                    AceFlags.None,
                    AceQualifier.AccessAllowed,
                    GenericAll,
                    sid,
                    isCallback: false,
                    opaque: null));
        }
        var bytes = new byte[acl.BinaryLength];
        acl.GetBinaryForm(bytes, 0);
        var aclPointer = Marshal.AllocHGlobal(bytes.Length);
        var infoPointer = Marshal.AllocHGlobal(Marshal.SizeOf<TokenDefaultDaclLayout>());
        try
        {
            Marshal.Copy(bytes, 0, aclPointer, bytes.Length);
            Marshal.StructureToPtr(
                new TokenDefaultDaclLayout { DefaultDacl = aclPointer },
                infoPointer,
                false);
            if (!SetTokenInformation(
                    token,
                    TokenDefaultDacl,
                    infoPointer,
                    checked((uint)Marshal.SizeOf<TokenDefaultDaclLayout>())))
            {
                throw Failure("SetTokenInformation(TokenDefaultDacl) failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(infoPointer);
            Marshal.FreeHGlobal(aclPointer);
        }
    }

    private static void EnablePrivilege(SafeAccessTokenHandle token, string privilegeName)
    {
        if (!LookupPrivilegeValue(null, privilegeName, out var luid))
        {
            throw Failure("LookupPrivilegeValue failed");
        }
        var privileges = new TokenPrivileges
        {
            PrivilegeCount = 1,
            Privilege = new LuidAndAttributes
            {
                Luid = luid,
                Attributes = SePrivilegeEnabled,
            },
        };
        if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero))
        {
            throw Failure("AdjustTokenPrivileges failed");
        }
        if (Marshal.GetLastWin32Error() == ErrorNotAllAssigned)
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "SeChangeNotifyPrivilege is unavailable on the restricted token");
        }
    }

    private static SecurityIdentifier GetLogonSid(SafeAccessTokenHandle token)
    {
        foreach (var entry in ReadTokenGroups(token, TokenGroups))
        {
            if ((entry.Attributes & SeGroupLogonId) == SeGroupLogonId)
            {
                return entry.Sid;
            }
        }
        throw new NativeExecutionException("process_start_failure", "runner token has no logon SID");
    }

    private static bool ContainsRestrictedSid(
        SafeAccessTokenHandle token,
        SecurityIdentifier expected) =>
        ReadTokenGroups(token, TokenRestrictedSids)
            .Any(entry => expected.Equals(entry.Sid));

    private static IReadOnlyList<TokenSid> ReadTokenGroups(
        SafeAccessTokenHandle token,
        int informationClass)
    {
        _ = GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out var required);
        if (required == 0)
        {
            throw Failure($"GetTokenInformation({informationClass}) size failed");
        }
        var buffer = Marshal.AllocHGlobal(checked((int)required));
        try
        {
            if (!GetTokenInformation(token, informationClass, buffer, required, out _))
            {
                throw Failure($"GetTokenInformation({informationClass}) failed");
            }
            var count = checked((int)(uint)Marshal.ReadInt32(buffer));
            var firstEntryOffset = Marshal.OffsetOf<TokenGroupsLayout>(nameof(TokenGroupsLayout.First)).ToInt32();
            var entrySize = Marshal.SizeOf<SidAndAttributes>();
            var entries = new List<TokenSid>(count);
            for (var index = 0; index < count; index++)
            {
                var entry = Marshal.PtrToStructure<SidAndAttributes>(
                    IntPtr.Add(buffer, checked(firstEntryOffset + index * entrySize)));
                if (entry.Sid != IntPtr.Zero)
                {
                    entries.Add(new TokenSid(new SecurityIdentifier(entry.Sid), entry.Attributes));
                }
            }
            return entries;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static NativeExecutionException Failure(string message) => new(
        "process_start_failure",
        message,
        innerException: new Win32Exception(Marshal.GetLastWin32Error()));

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        internal IntPtr Sid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenGroupsLayout
    {
        internal uint GroupCount;
        internal SidAndAttributes First;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenDefaultDaclLayout
    {
        internal IntPtr DefaultDacl;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        internal uint LowPart;
        internal int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAndAttributes
    {
        internal Luid Luid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        internal uint PrivilegeCount;
        internal LuidAndAttributes Privilege;
    }

    private sealed record TokenSid(SecurityIdentifier Sid, uint Attributes);

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

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        SafeProcessHandle process,
        uint desiredAccess,
        out SafeAccessTokenHandle token);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateRestrictedToken(
        SafeAccessTokenHandle existingToken,
        uint flags,
        uint disableSidCount,
        SidAndAttributes[]? sidsToDisable,
        uint deletePrivilegeCount,
        IntPtr privilegesToDelete,
        uint restrictedSidCount,
        SidAndAttributes[] sidsToRestrict,
        out SafeAccessTokenHandle newToken);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsTokenRestricted(SafeAccessTokenHandle token);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        SafeAccessTokenHandle token,
        int tokenInformationClass,
        IntPtr tokenInformation,
        uint tokenInformationLength,
        out uint returnLength);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetTokenInformation(
        SafeAccessTokenHandle token,
        int tokenInformationClass,
        IntPtr tokenInformation,
        uint tokenInformationLength);

    [DllImport("Advapi32.dll", EntryPoint = "LookupPrivilegeValueW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(string? systemName, string name, out Luid luid);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustTokenPrivileges(
        SafeAccessTokenHandle token,
        [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
        ref TokenPrivileges newState,
        uint bufferLength,
        IntPtr previousState,
        IntPtr returnLength);
}
