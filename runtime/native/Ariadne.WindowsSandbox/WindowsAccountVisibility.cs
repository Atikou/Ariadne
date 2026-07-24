using Microsoft.Win32;

namespace Ariadne.WindowsSandbox;

internal static class WindowsAccountVisibility
{
    private const string UserListRegistryPath =
        @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList";

    internal static void Apply(DesiredPolicy policy)
    {
        try
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var userList = machine.CreateSubKey(UserListRegistryPath, writable: true)
                ?? throw new SetupException("account_visibility_registry_unavailable");
            foreach (var accountName in ManagedAccountNames(policy))
            {
                userList.SetValue(accountName, 0, RegistryValueKind.DWord);
            }
        }
        catch (SetupException)
        {
            throw;
        }
        catch (Exception error) when (
            error is UnauthorizedAccessException or IOException or System.Security.SecurityException)
        {
            throw new SetupException("account_visibility_apply_failed", error);
        }
    }

    internal static bool Verify(DesiredPolicy policy)
    {
        try
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var userList = machine.OpenSubKey(UserListRegistryPath, writable: false);
            return userList is not null && ManagedAccountNames(policy).All(accountName =>
                IsHiddenRegistryValue(userList.GetValue(
                    accountName,
                    defaultValue: null,
                    RegistryValueOptions.DoNotExpandEnvironmentNames)));
        }
        catch (Exception error) when (
            error is UnauthorizedAccessException or IOException or System.Security.SecurityException)
        {
            throw new SetupException("account_visibility_verify_failed", error);
        }
    }

    internal static void RetirePrevious(SetupManifest previous, DesiredPolicy current)
    {
        var currentNames = ManagedAccountNames(current).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var retiredNames = new[] { previous.OfflineUser, previous.OnlineUser }
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(name => !currentNames.Contains(name))
            .ToArray();
        if (retiredNames.Length == 0) return;

        try
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var userList = machine.OpenSubKey(UserListRegistryPath, writable: true);
            if (userList is null) return;
            foreach (var accountName in retiredNames)
            {
                userList.DeleteValue(accountName, throwOnMissingValue: false);
            }
        }
        catch (Exception error) when (
            error is UnauthorizedAccessException or IOException or System.Security.SecurityException)
        {
            throw new SetupException("account_visibility_retire_failed", error);
        }
    }

    internal static bool IsHiddenRegistryValue(object? value) => value is int number && number == 0;

    private static IEnumerable<string> ManagedAccountNames(DesiredPolicy policy)
    {
        yield return policy.OfflineUser;
        yield return policy.OnlineUser;
    }
}
