using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.ExceptionServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsProcessHandles : IDisposable
{
    internal WindowsProcessHandles(SafeWaitHandle process, SafeWaitHandle thread, int processId)
    {
        Process = process;
        Thread = thread;
        ProcessId = processId;
    }

    internal SafeWaitHandle Process { get; }
    internal SafeWaitHandle Thread { get; }
    internal int ProcessId { get; }

    internal void Resume()
    {
        var previousSuspendCount = ResumeThread(Thread);
        if (previousSuspendCount == uint.MaxValue)
        {
            throw Failure("ResumeThread failed");
        }
        if (previousSuspendCount != 1)
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "created process primary thread had an unexpected suspend count");
        }
    }

    internal void TerminateAndWait(uint exitCode, int timeoutMilliseconds)
    {
        if (!TerminateProcess(Process, exitCode))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != 5 || !Wait(0))
            {
                throw Failure("TerminateProcess failed", error);
            }
        }
        if (!Wait(timeoutMilliseconds))
        {
            throw new NativeExecutionException(
                "protocol_failure",
                "terminated process did not converge before the cleanup deadline");
        }
    }

    internal bool Wait(int timeoutMilliseconds)
    {
        var result = WaitForSingleObject(Process, checked((uint)timeoutMilliseconds));
        return result switch
        {
            0 => true,
            258 => false,
            _ => throw Failure("WaitForSingleObject failed"),
        };
    }

    internal int ExitCode()
    {
        if (!GetExitCodeProcess(Process, out var exitCode))
        {
            throw Failure("GetExitCodeProcess failed");
        }
        return unchecked((int)exitCode);
    }

    public void Dispose()
    {
        Thread.Dispose();
        Process.Dispose();
    }

    private static NativeExecutionException Failure(string message, int? error = null) => new(
        "protocol_failure",
        message,
        innerException: new Win32Exception(error ?? Marshal.GetLastWin32Error()));

    [DllImport("Kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(SafeWaitHandle thread);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(SafeWaitHandle process, uint exitCode);

    [DllImport("Kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(SafeWaitHandle process, out uint exitCode);
}

internal static class WindowsProcessLauncher
{
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateBreakawayFromJob = 0x01000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const ulong ProcThreadAttributeHandleList = 0x00020002;
    private const ulong ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const ulong ProcThreadAttributeJobList = 0x0002000D;
    private const uint SeGroupEnabled = 0x00000004;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private const int StdInputHandle = -10;
    private const uint HandleFlagInherit = 0x00000001;

    internal static WindowsProcessHandles StartBatchRunner(
        SafeAccessTokenHandle token,
        WindowsJobObject job,
        string executable,
        string commandLine,
        string cwd,
        SafeFileHandle stdin,
        SafeFileHandle stdout,
        SafeFileHandle stderr)
    {
        using var environment = WindowsUserEnvironmentBlock.Create(token);
        using var attributes = ProcessThreadAttributeList.Create(
            [
                stdin.DangerousGetHandle(),
                stdout.DangerousGetHandle(),
                stderr.DangerousGetHandle(),
            ],
            job);
        var startup = new StartupInformationEx
        {
            StartupInformation = StartupInformation.Create(
                stdin.DangerousGetHandle(),
                stdout.DangerousGetHandle(),
                stderr.DangerousGetHandle()),
            AttributeList = attributes.Pointer,
        };
        startup.StartupInformation.Size = Marshal.SizeOf<StartupInformationEx>();
        var mutableCommandLine = new StringBuilder(commandLine);
        if (!CreateProcessAsUser(
                token,
                executable,
                mutableCommandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment | ExtendedStartupInfoPresent,
                environment.Pointer,
                cwd,
                ref startup,
                out var information))
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "CreateProcessAsUserW for batch runner failed",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
        return VerifyJobAndResume(information, job);
    }

    internal static WindowsProcessHandles StartRestricted(
        SafeAccessTokenHandle token,
        WindowsJobObject job,
        SecurityIdentifier appContainerSid,
        IReadOnlyCollection<SecurityIdentifier> appContainerCapabilities,
        string application,
        string commandLine,
        string cwd,
        IntPtr environment,
        string desktop,
        SafeFileHandle stdin,
        SafeFileHandle stdout,
        SafeFileHandle stderr)
    {
        using var attributes = ProcessThreadAttributeList.Create(
            [
                stdin.DangerousGetHandle(),
                stdout.DangerousGetHandle(),
                stderr.DangerousGetHandle(),
            ],
            appContainerSid,
            appContainerCapabilities,
            job);
        var startup = new StartupInformationEx
        {
            StartupInformation = StartupInformation.Create(
                stdin.DangerousGetHandle(),
                stdout.DangerousGetHandle(),
                stderr.DangerousGetHandle()),
            AttributeList = attributes.Pointer,
        };
        startup.StartupInformation.Desktop = desktop;
        startup.StartupInformation.Size = Marshal.SizeOf<StartupInformationEx>();
        var mutableCommandLine = new StringBuilder(commandLine);
        if (!CreateProcessAsUser(
                token,
                application,
                mutableCommandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateSuspended |
                CreateNoWindow |
                CreateUnicodeEnvironment |
                CreateBreakawayFromJob |
                ExtendedStartupInfoPresent,
                environment,
                cwd,
                ref startup,
                out var information))
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "CreateProcessAsUserW failed",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
        return VerifyJobAndResume(information, job);
    }

    internal static void DisableStandardHandleInheritance()
    {
        foreach (var standardHandle in new[] { StdInputHandle, StdOutputHandle, StdErrorHandle })
        {
            var handle = GetStdHandle(standardHandle);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) continue;
            if (!SetHandleInformation(handle, HandleFlagInherit, 0))
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "SetHandleInformation for runner protocol handle failed",
                    innerException: new Win32Exception(Marshal.GetLastWin32Error()));
            }
        }
    }

    private static WindowsProcessHandles Wrap(ProcessInformation information) => new(
        new SafeWaitHandle(information.Process, ownsHandle: true),
        new SafeWaitHandle(information.Thread, ownsHandle: true),
        checked((int)information.ProcessId));

    private static WindowsProcessHandles VerifyJobAndResume(
        ProcessInformation information,
        WindowsJobObject job)
    {
        var process = Wrap(information);
        try
        {
            if (!job.Contains(process.Process))
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "created process is not assigned to the requested Job Object");
            }
            process.Resume();
            return process;
        }
        catch (Exception startFailure)
        {
            Exception? cleanupFailure = null;
            try
            {
                process.TerminateAndWait(125, 10_000);
            }
            catch (Exception error)
            {
                cleanupFailure = error;
            }
            finally
            {
                process.Dispose();
            }
            if (cleanupFailure is not null)
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "failed to contain or resume the created process and cleanup did not converge",
                    innerException: new AggregateException(startFailure, cleanupFailure));
            }
            ExceptionDispatchInfo.Capture(startFailure).Throw();
            throw new InvalidOperationException("unreachable");
        }
    }

    private static NativeExecutionException LauncherFailure(string message) => new(
        "process_start_failure",
        message,
        innerException: new Win32Exception(Marshal.GetLastWin32Error()));

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInformation
    {
        internal int Size;
        internal string? Reserved;
        internal string? Desktop;
        internal string? Title;
        internal uint X;
        internal uint Y;
        internal uint XSize;
        internal uint YSize;
        internal uint XCountChars;
        internal uint YCountChars;
        internal uint FillAttribute;
        internal uint Flags;
        internal ushort ShowWindow;
        internal ushort Reserved2Size;
        internal IntPtr Reserved2;
        internal IntPtr StandardInput;
        internal IntPtr StandardOutput;
        internal IntPtr StandardError;

        internal static StartupInformation Create(IntPtr stdin, IntPtr stdout, IntPtr stderr) => new()
        {
            Size = Marshal.SizeOf<StartupInformation>(),
            Flags = StartfUseStdHandles,
            StandardInput = stdin,
            StandardOutput = stdout,
            StandardError = stderr,
        };
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process;
        internal IntPtr Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInformationEx
    {
        internal StartupInformation StartupInformation;
        internal IntPtr AttributeList;
    }

    private sealed class ProcessThreadAttributeList : IDisposable
    {
        private IntPtr pointer;
        private readonly List<IntPtr> allocations;

        private ProcessThreadAttributeList(IntPtr pointer, List<IntPtr> allocations)
        {
            this.pointer = pointer;
            this.allocations = allocations;
        }

        internal IntPtr Pointer => pointer;

        internal static ProcessThreadAttributeList Create(
            IReadOnlyCollection<IntPtr> handles,
            WindowsJobObject job) =>
            Create(handles, appContainerSid: null, [], job);

        internal static ProcessThreadAttributeList Create(
            IReadOnlyCollection<IntPtr> handles,
            SecurityIdentifier? appContainerSid,
            IReadOnlyCollection<SecurityIdentifier> appContainerCapabilities,
            WindowsJobObject job)
        {
            var uniqueHandles = handles.Distinct().ToArray();
            var attributeCount = appContainerSid is null ? 2 : 3;
            var required = IntPtr.Zero;
            _ = InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref required);
            if (required == IntPtr.Zero)
            {
                throw LauncherFailure("InitializeProcThreadAttributeList size failed");
            }
            var attributes = Marshal.AllocHGlobal(required);
            var allocations = new List<IntPtr>();
            var initialized = false;
            try
            {
                if (!InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref required))
                {
                    throw LauncherFailure("InitializeProcThreadAttributeList failed");
                }
                initialized = true;
                var handleList = Allocate(checked(uniqueHandles.Length * IntPtr.Size), allocations);
                for (var index = 0; index < uniqueHandles.Length; index++)
                {
                    Marshal.WriteIntPtr(handleList, checked(index * IntPtr.Size), uniqueHandles[index]);
                }
                if (!UpdateProcThreadAttribute(
                        attributes,
                        0,
                        new UIntPtr(ProcThreadAttributeHandleList),
                        handleList,
                        new IntPtr(checked(uniqueHandles.Length * IntPtr.Size)),
                        IntPtr.Zero,
                        IntPtr.Zero))
                {
                    throw LauncherFailure("UpdateProcThreadAttribute(handle list) failed");
                }
                if (appContainerSid is not null)
                {
                    var packageSid = AllocateSid(appContainerSid, allocations);
                    var capabilitySize = Marshal.SizeOf<SidAndAttributes>();
                    var capabilityEntries = appContainerCapabilities.Distinct().ToArray();
                    var capabilityList = Allocate(
                        checked(Math.Max(1, capabilityEntries.Length) * capabilitySize),
                        allocations);
                    for (var index = 0; index < capabilityEntries.Length; index++)
                    {
                        Marshal.StructureToPtr(
                            new SidAndAttributes
                            {
                                Sid = AllocateSid(capabilityEntries[index], allocations),
                                Attributes = SeGroupEnabled,
                            },
                            capabilityList + checked(index * capabilitySize),
                            fDeleteOld: false);
                    }
                    var securityCapabilities = Allocate(Marshal.SizeOf<SecurityCapabilities>(), allocations);
                    Marshal.StructureToPtr(
                        new SecurityCapabilities
                        {
                            AppContainerSid = packageSid,
                            Capabilities = capabilityEntries.Length == 0 ? IntPtr.Zero : capabilityList,
                            CapabilityCount = checked((uint)capabilityEntries.Length),
                        },
                        securityCapabilities,
                        fDeleteOld: false);
                    if (!UpdateProcThreadAttribute(
                            attributes,
                            0,
                            new UIntPtr(ProcThreadAttributeSecurityCapabilities),
                            securityCapabilities,
                            new IntPtr(Marshal.SizeOf<SecurityCapabilities>()),
                            IntPtr.Zero,
                            IntPtr.Zero))
                    {
                        throw LauncherFailure("UpdateProcThreadAttribute(security capabilities) failed");
                    }
                }
                var jobList = Allocate(IntPtr.Size, allocations);
                Marshal.WriteIntPtr(jobList, job.DangerousGetHandle());
                if (!UpdateProcThreadAttribute(
                        attributes,
                        0,
                        new UIntPtr(ProcThreadAttributeJobList),
                        jobList,
                        new IntPtr(IntPtr.Size),
                        IntPtr.Zero,
                        IntPtr.Zero))
                {
                    throw LauncherFailure("UpdateProcThreadAttribute(job list) failed");
                }
                return new ProcessThreadAttributeList(attributes, allocations);
            }
            catch
            {
                if (initialized) DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
                foreach (var allocation in allocations.AsEnumerable().Reverse()) Marshal.FreeHGlobal(allocation);
                throw;
            }
        }

        public void Dispose()
        {
            if (pointer != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(pointer);
                Marshal.FreeHGlobal(pointer);
                pointer = IntPtr.Zero;
            }
            foreach (var allocation in allocations.AsEnumerable().Reverse())
            {
                Marshal.FreeHGlobal(allocation);
            }
            allocations.Clear();
        }

        private static IntPtr Allocate(int bytes, ICollection<IntPtr> allocations)
        {
            var pointer = Marshal.AllocHGlobal(bytes);
            allocations.Add(pointer);
            return pointer;
        }

        private static IntPtr AllocateSid(
            SecurityIdentifier sid,
            ICollection<IntPtr> allocations)
        {
            var bytes = new byte[sid.BinaryLength];
            sid.GetBinaryForm(bytes, 0);
            var pointer = Allocate(bytes.Length, allocations);
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            return pointer;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        internal IntPtr Sid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        internal IntPtr AppContainerSid;
        internal IntPtr Capabilities;
        internal uint CapabilityCount;
        internal uint Reserved;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CreateProcessAsUserW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessAsUser(
        SafeAccessTokenHandle token,
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInformationEx startupInformation,
        out ProcessInformation processInformation);

    [DllImport("Kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        uint flags,
        ref IntPtr size);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        UIntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("Kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);
}
