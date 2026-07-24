using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;

namespace Ariadne.WindowsSandbox;

internal sealed record LocalGroupMemberPage(
    int Status,
    UIntPtr ResumeHandle,
    IReadOnlyList<string> Members,
    int TotalEntries);

internal static class WindowsAccountManager
{
    private const string UserMarker = "Ariadne managed sandbox account v1";
    private const string GroupMarker = "Ariadne managed sandbox writer group v1";
    private const int NerrSuccess = 0;
    private const int NerrUserExists = 2224;
    private const int NerrGroupExists = 2223;
    private const int NerrUserNotFound = 2221;
    private const int ErrorMemberNotInAlias = 1377;
    private const int ErrorMemberInAlias = 1378;
    private const int ErrorNoSuchMember = 1387;
    private const int ErrorMoreData = 234;
    private const int MaxGroupMemberPages = 1024;
    private const int MaxGroupMembers = 65_536;
    private const int UserPrivUser = 1;
    private const int UfScript = 0x0001;
    private const int UfPasswordCantChange = 0x0040;
    private const int UfNormalAccount = 0x0200;
    private const int UfDontExpirePassword = 0x10000;
    private const int UfNotDelegated = 0x100000;

    internal static ManagedIdentity Provision(DesiredPolicy policy)
    {
        EnsureManagedGroup(policy.WriterGroup);
        var offlinePassword = GeneratePassword();
        var onlinePassword = GeneratePassword();
        EnsureManagedUser(policy.OfflineUser, offlinePassword);
        EnsureManagedUser(policy.OnlineUser, onlinePassword);
        AddMember(policy.WriterGroup, QualifiedName(policy.OfflineUser));
        AddMember(policy.WriterGroup, QualifiedName(policy.OnlineUser));
        EnforceExactWriterMembers(policy);
        RemoveAdministrativeMembership(policy.OfflineUser);
        RemoveAdministrativeMembership(policy.OnlineUser);
        RemoveAdministrativeMembership(policy.WriterGroup);
        return new ManagedIdentity(
            ResolveSid(policy.OfflineUser).Value,
            ResolveSid(policy.OnlineUser).Value,
            ResolveSid(policy.WriterGroup).Value,
            offlinePassword,
            onlinePassword);
    }

    internal static bool Verify(DesiredPolicy policy, SetupManifest manifest, string offlinePassword, string onlinePassword)
    {
        return VerifyManagedUser(policy.OfflineUser, manifest.OfflineUserSid) &&
            VerifyManagedUser(policy.OnlineUser, manifest.OnlineUserSid) &&
            VerifyManagedGroup(policy.WriterGroup, manifest.WriterGroupSid) &&
            HasExactWriterMembers(policy) &&
            !IsAdministrator(policy.OfflineUser) &&
            !IsAdministrator(policy.OnlineUser) &&
            !IsAdministrator(policy.WriterGroup) &&
            ValidateCredentials(policy.OfflineUser, offlinePassword) &&
            ValidateCredentials(policy.OnlineUser, onlinePassword);
    }

    internal static void RetirePreviousIdentities(SetupManifest previous, DesiredPolicy current)
    {
        var currentUsers = new HashSet<string>(
            [current.OfflineUser, current.OnlineUser],
            StringComparer.OrdinalIgnoreCase);
        foreach (var previousUser in new[] { previous.OfflineUser, previous.OnlineUser }
                     .Distinct(StringComparer.OrdinalIgnoreCase)
                     .Where(user => !currentUsers.Contains(user)))
        {
            var existing = GetUser(previousUser);
            if (existing is null) continue;
            if (!string.Equals(existing.Value.Comment, UserMarker, StringComparison.Ordinal))
            {
                throw new SetupException("previous_managed_user_marker_changed");
            }
            var status = NetUserDel(null, previousUser);
            if (status != NerrSuccess && status != NerrUserNotFound)
            {
                ThrowNetApi("previous_managed_user_delete_failed", status);
            }
        }
        if (string.Equals(previous.WriterGroup, current.WriterGroup, StringComparison.OrdinalIgnoreCase)) return;
        var existingGroup = GetGroup(previous.WriterGroup);
        if (existingGroup is null) return;
        if (!string.Equals(existingGroup.Value.Comment, GroupMarker, StringComparison.Ordinal))
        {
            throw new SetupException("previous_managed_group_marker_changed");
        }
        var groupStatus = NetLocalGroupDel(null, previous.WriterGroup);
        if (groupStatus != NerrSuccess && groupStatus != 2220)
        {
            ThrowNetApi("previous_managed_group_delete_failed", groupStatus);
        }
    }

    private static void EnsureManagedUser(string name, string password)
    {
        var existing = GetUser(name);
        if (existing is not null && !string.Equals(existing.Value.Comment, UserMarker, StringComparison.Ordinal))
        {
            throw new SetupException("managed_user_name_collision");
        }
        if (existing is null)
        {
            var info = new UserInfo1
            {
                Name = name,
                Password = password,
                Privilege = UserPrivUser,
                Comment = UserMarker,
                Flags = ManagedUserFlags,
            };
            var status = NetUserAdd(null, 1, ref info, out _);
            if (status != NerrSuccess && status != NerrUserExists) ThrowNetApi("managed_user_create_failed", status);
        }
        var passwordInfo = new UserInfo1003 { Password = password };
        var passwordStatus = NetUserSetInfo(null, name, 1003, ref passwordInfo, out _);
        if (passwordStatus != NerrSuccess) ThrowNetApi("managed_user_password_update_failed", passwordStatus);
        var flagsInfo = new UserInfo1008
        {
            Flags = ManagedUserFlags,
        };
        var flagsStatus = NetUserSetInfoFlags(null, name, 1008, ref flagsInfo, out _);
        if (flagsStatus != NerrSuccess) ThrowNetApi("managed_user_flags_update_failed", flagsStatus);
    }

    private static void EnsureManagedGroup(string name)
    {
        var existing = GetGroup(name);
        if (existing is not null && !string.Equals(existing.Value.Comment, GroupMarker, StringComparison.Ordinal))
        {
            throw new SetupException("managed_group_name_collision");
        }
        if (existing is not null) return;
        var info = new LocalGroupInfo1 { Name = name, Comment = GroupMarker };
        var status = NetLocalGroupAdd(null, 1, ref info, out _);
        if (status != NerrSuccess && status != NerrGroupExists) ThrowNetApi("managed_group_create_failed", status);
    }

    private static bool VerifyManagedUser(string name, string expectedSid)
    {
        var user = GetUser(name);
        return user is not null &&
            string.Equals(user.Value.Comment, UserMarker, StringComparison.Ordinal) &&
            (user.Value.Flags & ManagedUserFlags) == ManagedUserFlags &&
            (user.Value.Flags & 0x0002) == 0 &&
            string.Equals(ResolveSid(name).Value, expectedSid, StringComparison.Ordinal);
    }

    private static bool VerifyManagedGroup(string name, string expectedSid)
    {
        var group = GetGroup(name);
        return group is not null &&
            string.Equals(group.Value.Comment, GroupMarker, StringComparison.Ordinal) &&
            string.Equals(ResolveSid(name).Value, expectedSid, StringComparison.Ordinal);
    }

    private static (string Name, string Comment, int Flags)? GetUser(string name)
    {
        var status = NetUserGetInfo(null, name, 1, out var buffer);
        if (status == NerrUserNotFound) return null;
        if (status != NerrSuccess) ThrowNetApi("managed_user_query_failed", status);
        try
        {
            var info = Marshal.PtrToStructure<UserInfo1>(buffer);
            return (info.Name ?? string.Empty, info.Comment ?? string.Empty, info.Flags);
        }
        finally
        {
            NetApiBufferFree(buffer);
        }
    }

    private static (string Name, string Comment)? GetGroup(string name)
    {
        var status = NetLocalGroupGetInfo(null, name, 1, out var buffer);
        if (status == 2220) return null;
        if (status != NerrSuccess) ThrowNetApi("managed_group_query_failed", status);
        try
        {
            var info = Marshal.PtrToStructure<LocalGroupInfo1>(buffer);
            return (info.Name ?? string.Empty, info.Comment ?? string.Empty);
        }
        finally
        {
            NetApiBufferFree(buffer);
        }
    }

    private static void AddMember(string group, string member)
    {
        var info = new LocalGroupMembersInfo3 { DomainAndName = member };
        var status = NetLocalGroupAddMembers(null, group, 3, ref info, 1);
        if (status != NerrSuccess && status != ErrorMemberInAlias) ThrowNetApi("managed_group_member_add_failed", status);
    }

    private static void EnforceExactWriterMembers(DesiredPolicy policy)
    {
        var expected = ExpectedWriterMembers(policy);
        foreach (var member in GetMembers(policy.WriterGroup).Where(member => !expected.Contains(member)))
        {
            var info = new LocalGroupMembersInfo3 { DomainAndName = member };
            var status = NetLocalGroupDelMembers(null, policy.WriterGroup, 3, ref info, 1);
            if (status != NerrSuccess && status != ErrorMemberNotInAlias && status != ErrorNoSuchMember)
            {
                ThrowNetApi("managed_group_foreign_member_remove_failed", status);
            }
        }
    }

    private static bool HasExactWriterMembers(DesiredPolicy policy) =>
        GetMembers(policy.WriterGroup).SetEquals(ExpectedWriterMembers(policy));

    private static HashSet<string> ExpectedWriterMembers(DesiredPolicy policy) => new(
        [QualifiedName(policy.OfflineUser), QualifiedName(policy.OnlineUser)],
        StringComparer.OrdinalIgnoreCase);

    private static void RemoveAdministrativeMembership(string member)
    {
        var administrators = ((NTAccount)new SecurityIdentifier(
            WellKnownSidType.BuiltinAdministratorsSid,
            null).Translate(typeof(NTAccount))).Value.Split('\\').Last();
        var info = new LocalGroupMembersInfo3 { DomainAndName = QualifiedName(member) };
        var status = NetLocalGroupDelMembers(null, administrators, 3, ref info, 1);
        if (status != NerrSuccess && status != ErrorMemberNotInAlias && status != ErrorNoSuchMember)
        {
            ThrowNetApi("administrator_membership_remove_failed", status);
        }
    }

    private static bool IsAdministrator(string member)
    {
        var administrators = ((NTAccount)new SecurityIdentifier(
            WellKnownSidType.BuiltinAdministratorsSid,
            null).Translate(typeof(NTAccount))).Value.Split('\\').Last();
        return IsMember(administrators, QualifiedName(member));
    }

    private static bool IsMember(string group, string member)
        => GetMembers(group).Contains(member);

    private static HashSet<string> GetMembers(string group) =>
        CollectMembers(resumeHandle => ReadMemberPage(group, resumeHandle));

    internal static HashSet<string> CollectMembers(Func<UIntPtr, LocalGroupMemberPage> readPage)
    {
        ArgumentNullException.ThrowIfNull(readPage);
        var members = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var resumeHandle = UIntPtr.Zero;
        var enumeratedEntries = 0;
        for (var pageNumber = 0; pageNumber < MaxGroupMemberPages; pageNumber++)
        {
            var page = readPage(resumeHandle);
            if (page.Status is not NerrSuccess and not ErrorMoreData)
            {
                ThrowNetApi("managed_group_members_query_failed", page.Status);
            }
            if (page.TotalEntries < 0 || page.TotalEntries > MaxGroupMembers ||
                page.Members.Count > MaxGroupMembers - enumeratedEntries)
            {
                throw new SetupException("managed_group_members_limit_exceeded");
            }
            enumeratedEntries += page.Members.Count;
            foreach (var member in page.Members)
            {
                if (!string.IsNullOrWhiteSpace(member)) members.Add(member);
            }
            if (page.Status == NerrSuccess) return members;
            if (page.Members.Count == 0 ||
                page.ResumeHandle == UIntPtr.Zero ||
                page.ResumeHandle == resumeHandle)
            {
                throw new SetupException("managed_group_members_pagination_stalled");
            }
            resumeHandle = page.ResumeHandle;
        }
        throw new SetupException("managed_group_members_page_limit_exceeded");
    }

    private static LocalGroupMemberPage ReadMemberPage(string group, UIntPtr resumeHandle)
    {
        var buffer = IntPtr.Zero;
        var status = NetLocalGroupGetMembers(
            null,
            group,
            3,
            out buffer,
            -1,
            out var entriesRead,
            out var totalEntries,
            ref resumeHandle);
        try
        {
            if (status is not NerrSuccess and not ErrorMoreData)
            {
                ThrowNetApi("managed_group_members_query_failed", status);
            }
            if (entriesRead < 0 || totalEntries < 0 || entriesRead > 0 && buffer == IntPtr.Zero)
            {
                throw new SetupException("managed_group_members_page_invalid");
            }
            var members = new List<string>(entriesRead);
            var size = Marshal.SizeOf<LocalGroupMembersInfo3>();
            for (var index = 0; index < entriesRead; index++)
            {
                var info = Marshal.PtrToStructure<LocalGroupMembersInfo3>(buffer + index * size);
                if (!string.IsNullOrWhiteSpace(info.DomainAndName)) members.Add(info.DomainAndName);
            }
            return new LocalGroupMemberPage(status, resumeHandle, members, totalEntries);
        }
        finally
        {
            if (buffer != IntPtr.Zero) _ = NetApiBufferFree(buffer);
        }
    }

    private static bool ValidateCredentials(string userName, string password)
    {
        try
        {
            using var token = WindowsBatchLogon.Logon(userName, password);
            using var identity = new WindowsIdentity(token.DangerousGetHandle());
            return !new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch (NativeExecutionException error) when (
            error.Code is "credential_failure" or "process_start_failure")
        {
            return false;
        }
    }

    private static SecurityIdentifier ResolveSid(string name) =>
        (SecurityIdentifier)new NTAccount(Environment.MachineName, name).Translate(typeof(SecurityIdentifier));

    private static string QualifiedName(string name) => $"{Environment.MachineName}\\{name}";

    private static string GeneratePassword()
    {
        var bytes = RandomNumberGenerator.GetBytes(36);
        try
        {
            return $"Aa1!{Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')}";
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static void ThrowNetApi(string code, int status) =>
        throw new SetupException(code, new Win32Exception(status));

    private const int ManagedUserFlags =
        UfScript | UfNormalAccount | UfPasswordCantChange | UfDontExpirePassword | UfNotDelegated;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct UserInfo1
    {
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Name;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Password;
        internal int PasswordAge;
        internal int Privilege;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? HomeDirectory;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Comment;
        internal int Flags;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? ScriptPath;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct UserInfo1003
    {
        [MarshalAs(UnmanagedType.LPWStr)] internal string Password;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UserInfo1008
    {
        internal int Flags;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct LocalGroupInfo1
    {
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Name;
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Comment;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct LocalGroupMembersInfo3
    {
        [MarshalAs(UnmanagedType.LPWStr)] internal string? DomainAndName;
    }

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetUserAdd(string? serverName, int level, ref UserInfo1 buffer, out int parameterError);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetUserGetInfo(string? serverName, string userName, int level, out IntPtr buffer);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetUserDel(string? serverName, string userName);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetUserSetInfo(string? serverName, string userName, int level, ref UserInfo1003 buffer, out int parameterError);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "NetUserSetInfo")]
    private static extern int NetUserSetInfoFlags(string? serverName, string userName, int level, ref UserInfo1008 buffer, out int parameterError);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetLocalGroupAdd(string? serverName, int level, ref LocalGroupInfo1 buffer, out int parameterError);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetLocalGroupGetInfo(string? serverName, string groupName, int level, out IntPtr buffer);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetLocalGroupDel(string? serverName, string groupName);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetLocalGroupAddMembers(string? serverName, string groupName, int level, ref LocalGroupMembersInfo3 buffer, int totalEntries);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetLocalGroupDelMembers(string? serverName, string groupName, int level, ref LocalGroupMembersInfo3 buffer, int totalEntries);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetLocalGroupGetMembers(string? serverName, string groupName, int level, out IntPtr buffer, int preferredMaximumLength, out int entriesRead, out int totalEntries, ref UIntPtr resumeHandle);

    [DllImport("Netapi32.dll")]
    private static extern int NetApiBufferFree(IntPtr buffer);

}
