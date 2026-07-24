using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Ariadne.WindowsSandbox;

internal sealed record BrokerServiceConfigurationSnapshot(
    uint ServiceType,
    uint StartType,
    uint ErrorControl,
    string BinaryPath,
    string LoadOrderGroup,
    uint TagId,
    IReadOnlyList<string> Dependencies,
    string ServiceStartName,
    string DisplayName,
    IReadOnlyList<string> RequiredPrivileges);

internal static class WindowsSandboxBrokerServicePolicy
{
    internal const uint ServiceWin32OwnProcess = 0x00000010;
    internal const uint ServiceAutoStart = 0x00000002;
    internal const uint ServiceErrorNormal = 0x00000001;
    internal const string DisplayName = "Ariadne Windows Sandbox Broker";

    private const uint ServiceConfigRequiredPrivilegesInfo = 6;
    private const int ErrorInsufficientBuffer = 122;
    private const int MaximumMultiStringEntries = 64;

    internal static readonly string[] RequiredPrivileges =
    [
        "SeAssignPrimaryTokenPrivilege",
        "SeIncreaseQuotaPrivilege",
        "SeImpersonatePrivilege",
    ];

    internal static string RequiredPrivilegesMultiString =>
        string.Join('\0', RequiredPrivileges) + "\0";

    internal static string BuildBinaryPath(
        string executable,
        string stateRoot,
        string ownerSid) => string.Join(' ', new[]
    {
        WindowsCommandLine.QuoteArgument(executable),
        "broker-service",
        "--state-root",
        WindowsCommandLine.QuoteArgument(stateRoot),
        "--owner-sid",
        WindowsCommandLine.QuoteArgument(ownerSid),
    });

    internal static bool Matches(
        BrokerServiceConfigurationSnapshot actual,
        string expectedBinaryPath)
    {
        if (actual.ServiceType != ServiceWin32OwnProcess ||
            actual.StartType != ServiceAutoStart ||
            actual.ErrorControl != ServiceErrorNormal ||
            !string.Equals(actual.BinaryPath, expectedBinaryPath, StringComparison.Ordinal) ||
            !string.IsNullOrEmpty(actual.LoadOrderGroup) ||
            actual.TagId != 0 ||
            actual.Dependencies.Count != 0 ||
            !IsLocalSystem(actual.ServiceStartName) ||
            !string.Equals(actual.DisplayName, DisplayName, StringComparison.Ordinal))
        {
            return false;
        }

        var required = RequiredPrivileges.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var configured = actual.RequiredPrivileges.ToHashSet(StringComparer.OrdinalIgnoreCase);
        return configured.Count == actual.RequiredPrivileges.Count &&
               configured.Count == required.Count &&
               configured.SetEquals(required);
    }

    internal static BrokerServiceConfigurationSnapshot Read(IntPtr serviceHandle)
    {
        var configuration = ReadBaseConfiguration(serviceHandle);
        return configuration with
        {
            RequiredPrivileges = ReadRequiredPrivileges(serviceHandle),
        };
    }

    private static bool IsLocalSystem(string account) =>
        string.Equals(account, "LocalSystem", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(account, @"NT AUTHORITY\LocalSystem", StringComparison.OrdinalIgnoreCase);

    private static BrokerServiceConfigurationSnapshot ReadBaseConfiguration(IntPtr serviceHandle)
    {
        _ = QueryServiceConfig(serviceHandle, IntPtr.Zero, 0, out var requiredBytes);
        if (requiredBytes == 0 || Marshal.GetLastWin32Error() != ErrorInsufficientBuffer)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        var buffer = Marshal.AllocHGlobal(checked((int)requiredBytes));
        try
        {
            if (!QueryServiceConfig(serviceHandle, buffer, requiredBytes, out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var value = Marshal.PtrToStructure<QueryServiceConfigData>(buffer);
            return new BrokerServiceConfigurationSnapshot(
                value.ServiceType,
                value.StartType,
                value.ErrorControl,
                ReadString(value.BinaryPathName),
                ReadString(value.LoadOrderGroup),
                value.TagId,
                ReadMultiString(value.Dependencies, buffer, requiredBytes),
                ReadString(value.ServiceStartName),
                ReadString(value.DisplayName),
                []);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static IReadOnlyList<string> ReadRequiredPrivileges(IntPtr serviceHandle)
    {
        _ = QueryServiceConfig2(
            serviceHandle,
            ServiceConfigRequiredPrivilegesInfo,
            IntPtr.Zero,
            0,
            out var requiredBytes);
        if (requiredBytes == 0 || Marshal.GetLastWin32Error() != ErrorInsufficientBuffer)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        var buffer = Marshal.AllocHGlobal(checked((int)requiredBytes));
        try
        {
            if (!QueryServiceConfig2(
                    serviceHandle,
                    ServiceConfigRequiredPrivilegesInfo,
                    buffer,
                    requiredBytes,
                    out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var information = Marshal.PtrToStructure<ServiceRequiredPrivilegesInfo>(buffer);
            return ReadMultiString(information.RequiredPrivileges, buffer, requiredBytes);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string ReadString(IntPtr pointer) =>
        pointer == IntPtr.Zero ? string.Empty : Marshal.PtrToStringUni(pointer) ?? string.Empty;

    private static IReadOnlyList<string> ReadMultiString(
        IntPtr pointer,
        IntPtr buffer,
        uint bufferBytes)
    {
        if (pointer == IntPtr.Zero) return [];
        var start = buffer.ToInt64();
        var end = checked(start + bufferBytes);
        var current = pointer.ToInt64();
        if (current < start || current >= end || (current - start) % sizeof(char) != 0)
        {
            throw new Win32Exception("service configuration MULTI_SZ pointer is outside its query buffer");
        }

        var values = new List<string>();
        while (current < end)
        {
            var length = 0;
            while (checked(current + (long)length * sizeof(char) + sizeof(char)) <= end &&
                   Marshal.ReadInt16(new IntPtr(current), checked(length * sizeof(char))) != 0)
            {
                length++;
            }
            if (checked(current + (long)length * sizeof(char) + sizeof(char)) > end)
            {
                throw new Win32Exception("service configuration MULTI_SZ is not terminated");
            }
            if (length == 0) return values;
            values.Add(Marshal.PtrToStringUni(new IntPtr(current), length) ?? string.Empty);
            if (values.Count > MaximumMultiStringEntries)
            {
                throw new Win32Exception("service configuration MULTI_SZ exceeds its entry limit");
            }
            current = checked(current + (long)(length + 1) * sizeof(char));
        }
        throw new Win32Exception("service configuration MULTI_SZ lacks its final terminator");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct QueryServiceConfigData
    {
        internal uint ServiceType;
        internal uint StartType;
        internal uint ErrorControl;
        internal IntPtr BinaryPathName;
        internal IntPtr LoadOrderGroup;
        internal uint TagId;
        internal IntPtr Dependencies;
        internal IntPtr ServiceStartName;
        internal IntPtr DisplayName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceRequiredPrivilegesInfo
    {
        internal IntPtr RequiredPrivileges;
    }

    [DllImport("Advapi32.dll", EntryPoint = "QueryServiceConfigW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig(
        IntPtr service,
        IntPtr configuration,
        uint bufferSize,
        out uint bytesNeeded);

    [DllImport("Advapi32.dll", EntryPoint = "QueryServiceConfig2W", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig2(
        IntPtr service,
        uint informationLevel,
        IntPtr buffer,
        uint bufferSize,
        out uint bytesNeeded);
}
