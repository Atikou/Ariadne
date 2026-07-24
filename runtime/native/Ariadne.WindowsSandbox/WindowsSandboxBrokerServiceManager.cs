using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal static class WindowsSandboxBrokerServiceManager
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ScManagerCreateService = 0x0002;
    private const uint ServiceQueryConfig = 0x0001;
    private const uint ServiceQueryStatus = 0x0004;
    private const uint ServiceChangeConfig = 0x0002;
    private const uint ServiceStart = 0x0010;
    private const uint ServiceStop = 0x0020;
    private const uint ServiceConfigDescription = 1;
    private const uint ServiceConfigRequiredPrivilegesInfo = 6;
    private const int ScStatusProcessInfo = 0;
    private const uint ServiceStopped = 1;
    private const uint ServiceStopPending = 3;
    private const uint ServiceRunning = 4;
    private const uint ServiceControlStop = 1;
    private const int ErrorServiceExists = 1073;
    private const int ErrorServiceAlreadyRunning = 1056;
    private const int ErrorServiceDoesNotExist = 1060;

    internal static string ServiceName(string stateRoot, SecurityIdentifier ownerSid)
    {
        var identity = $"{PathPolicy.NormalizeAbsolute(stateRoot, "--state-root").ToUpperInvariant()}\0{ownerSid.Value}";
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant();
        return $"AriadneSandboxBroker-{digest[..16]}";
    }

    internal static void Apply(DesiredPolicy policy, SecurityIdentifier ownerSid)
    {
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
        {
            throw new SetupException("broker_service_executable_unavailable");
        }
        var name = ServiceName(policy.StateRoot, ownerSid);
        var binaryPath = WindowsSandboxBrokerServicePolicy.BuildBinaryPath(
            executable,
            policy.StateRoot,
            ownerSid.Value);
        try
        {
            using var manager = OpenScManager(ScManagerConnect | ScManagerCreateService);
            SafeServiceHandle service;
            var created = CreateService(
                manager,
                name,
                WindowsSandboxBrokerServicePolicy.DisplayName,
                ServiceQueryStatus | ServiceChangeConfig | ServiceStart | ServiceStop,
                WindowsSandboxBrokerServicePolicy.ServiceWin32OwnProcess,
                WindowsSandboxBrokerServicePolicy.ServiceAutoStart,
                WindowsSandboxBrokerServicePolicy.ServiceErrorNormal,
                binaryPath,
                null,
                IntPtr.Zero,
                null,
                null,
                null);
            if (!created.IsInvalid)
            {
                service = created;
            }
            else
            {
                var error = Marshal.GetLastWin32Error();
                created.Dispose();
                if (error != ErrorServiceExists) throw new Win32Exception(error);
                service = OpenServiceChecked(
                    manager,
                    name,
                    ServiceQueryStatus | ServiceChangeConfig | ServiceStart | ServiceStop);
            }
            using (service)
            {
                StopIfRunning(service, TimeSpan.FromSeconds(30));
                if (!ChangeServiceConfig(
                        service,
                        WindowsSandboxBrokerServicePolicy.ServiceWin32OwnProcess,
                        WindowsSandboxBrokerServicePolicy.ServiceAutoStart,
                        WindowsSandboxBrokerServicePolicy.ServiceErrorNormal,
                        binaryPath,
                        null,
                        IntPtr.Zero,
                        null,
                        null,
                        null,
                        WindowsSandboxBrokerServicePolicy.DisplayName))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                SetDescription(service);
                SetRequiredPrivileges(service);
                if (!StartService(service, 0, IntPtr.Zero))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != ErrorServiceAlreadyRunning) throw new Win32Exception(error);
                }
                WaitForRunning(service, TimeSpan.FromSeconds(20));
            }
        }
        catch (Exception error) when (error is Win32Exception or TimeoutException)
        {
            throw new SetupException("broker_service_apply_failed", error);
        }
    }

    internal static void QuiesceForSetup(DesiredPolicy policy, SecurityIdentifier ownerSid)
    {
        try
        {
            using var manager = OpenScManager(ScManagerConnect);
            using var service = OpenServiceChecked(
                manager,
                ServiceName(policy.StateRoot, ownerSid),
                ServiceQueryStatus | ServiceStop);
            StopIfRunning(service, TimeSpan.FromSeconds(30));
        }
        catch (Win32Exception error) when (error.NativeErrorCode == ErrorServiceDoesNotExist)
        {
        }
        catch (Exception error) when (error is Win32Exception or TimeoutException)
        {
            throw new SetupException("broker_service_quiesce_failed", error);
        }
    }

    internal static bool Verify(DesiredPolicy policy, SecurityIdentifier ownerSid)
    {
        try
        {
            var executable = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable)) return false;
            var expectedBinaryPath = WindowsSandboxBrokerServicePolicy.BuildBinaryPath(
                executable,
                policy.StateRoot,
                ownerSid.Value);
            using var manager = OpenScManager(ScManagerConnect);
            using var service = OpenServiceChecked(
                manager,
                ServiceName(policy.StateRoot, ownerSid),
                ServiceQueryStatus | ServiceQueryConfig);
            var status = QueryStatus(service);
            return status.CurrentState == ServiceRunning &&
                   status.ProcessId != 0 &&
                   status.ServiceType == WindowsSandboxBrokerServicePolicy.ServiceWin32OwnProcess &&
                   WindowsSandboxBrokerServicePolicy.Matches(
                       WindowsSandboxBrokerServicePolicy.Read(service.DangerousGetHandle()),
                       expectedBinaryPath);
        }
        catch (Win32Exception)
        {
            return false;
        }
    }

    private static SafeServiceHandle OpenScManager(uint access)
    {
        var handle = OpenSCManager(null, null, access);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }

    private static SafeServiceHandle OpenServiceChecked(SafeServiceHandle manager, string name, uint access)
    {
        var handle = OpenService(manager, name, access);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }

    private static void WaitForRunning(SafeServiceHandle service, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var status = QueryStatus(service);
            if (status.CurrentState == ServiceRunning) return;
            if (status.CurrentState == ServiceStopped)
            {
                throw new Win32Exception(unchecked((int)status.Win32ExitCode));
            }
            Thread.Sleep(100);
        }
        throw new TimeoutException("sandbox broker service start timed out");
    }

    private static void StopIfRunning(SafeServiceHandle service, TimeSpan timeout)
    {
        var status = QueryStatus(service);
        if (status.CurrentState == ServiceStopped) return;
        if (status.CurrentState != ServiceStopPending &&
            !ControlService(service, ServiceControlStop, out _))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != 1062) throw new Win32Exception(error);
        }
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (QueryStatus(service).CurrentState == ServiceStopped) return;
            Thread.Sleep(100);
        }
        throw new TimeoutException("sandbox broker service stop timed out");
    }

    private static ServiceStatusProcess QueryStatus(SafeServiceHandle service)
    {
        var size = Marshal.SizeOf<ServiceStatusProcess>();
        if (!QueryServiceStatusEx(service, ScStatusProcessInfo, out var status, size, out _))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return status;
    }

    private static void SetDescription(SafeServiceHandle service)
    {
        var text = Marshal.StringToHGlobalUni("Runs approved Ariadne commands under non-interactive sandbox identities.");
        try
        {
            var description = new ServiceDescription { Description = text };
            if (!ChangeServiceConfig2(service, ServiceConfigDescription, ref description))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(text);
        }
    }

    private static void SetRequiredPrivileges(SafeServiceHandle service)
    {
        var privileges = Marshal.StringToHGlobalUni(
            WindowsSandboxBrokerServicePolicy.RequiredPrivilegesMultiString);
        try
        {
            var information = new ServiceRequiredPrivilegesInfo { RequiredPrivileges = privileges };
            if (!ChangeServiceConfig2Privileges(service, ServiceConfigRequiredPrivilegesInfo, ref information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(privileges);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        internal uint ServiceType;
        internal uint CurrentState;
        internal uint ControlsAccepted;
        internal uint Win32ExitCode;
        internal uint ServiceSpecificExitCode;
        internal uint CheckPoint;
        internal uint WaitHint;
        internal uint ProcessId;
        internal uint ServiceFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        internal uint ServiceType;
        internal uint CurrentState;
        internal uint ControlsAccepted;
        internal uint Win32ExitCode;
        internal uint ServiceSpecificExitCode;
        internal uint CheckPoint;
        internal uint WaitHint;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceDescription
    {
        internal IntPtr Description;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceRequiredPrivilegesInfo
    {
        internal IntPtr RequiredPrivileges;
    }

    private sealed class SafeServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeServiceHandle() : base(ownsHandle: true) { }

        protected override bool ReleaseHandle() => CloseServiceHandle(handle);
    }

    [DllImport("Advapi32.dll", EntryPoint = "OpenSCManagerW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeServiceHandle OpenSCManager(string? machineName, string? databaseName, uint desiredAccess);

    [DllImport("Advapi32.dll", EntryPoint = "CreateServiceW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeServiceHandle CreateService(
        SafeServiceHandle manager,
        string serviceName,
        string displayName,
        uint desiredAccess,
        uint serviceType,
        uint startType,
        uint errorControl,
        string binaryPathName,
        string? loadOrderGroup,
        IntPtr tagId,
        string? dependencies,
        string? serviceStartName,
        string? password);

    [DllImport("Advapi32.dll", EntryPoint = "OpenServiceW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeServiceHandle OpenService(
        SafeServiceHandle manager,
        string serviceName,
        uint desiredAccess);

    [DllImport("Advapi32.dll", EntryPoint = "ChangeServiceConfigW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig(
        SafeServiceHandle service,
        uint serviceType,
        uint startType,
        uint errorControl,
        string binaryPathName,
        string? loadOrderGroup,
        IntPtr tagId,
        string? dependencies,
        string? serviceStartName,
        string? password,
        string displayName);

    [DllImport("Advapi32.dll", EntryPoint = "ChangeServiceConfig2W", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig2(
        SafeServiceHandle service,
        uint infoLevel,
        ref ServiceDescription information);

    [DllImport("Advapi32.dll", EntryPoint = "ChangeServiceConfig2W", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig2Privileges(
        SafeServiceHandle service,
        uint infoLevel,
        ref ServiceRequiredPrivilegesInfo information);

    [DllImport("Advapi32.dll", EntryPoint = "StartServiceW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartService(SafeServiceHandle service, uint argumentCount, IntPtr arguments);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(
        SafeServiceHandle service,
        int infoLevel,
        out ServiceStatusProcess status,
        int bufferSize,
        out int bytesNeeded);

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ControlService(
        SafeServiceHandle service,
        uint control,
        out ServiceStatus status);

    [DllImport("Advapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr service);
}
