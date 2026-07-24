using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsJobObject : IDisposable
{
    private const uint JobObjectLimitJobTime = 0x00000004;
    private const uint JobObjectLimitActiveProcess = 0x00000008;
    private const uint JobObjectLimitJobMemory = 0x00000200;
    private const uint JobObjectLimitDieOnUnhandledException = 0x00000400;
    private const uint JobObjectLimitBreakawayOk = 0x00000800;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint JobObjectUiLimitHandles = 0x00000001;
    private const uint JobObjectUiLimitReadClipboard = 0x00000002;
    private const uint JobObjectUiLimitWriteClipboard = 0x00000004;
    private const uint JobObjectUiLimitSystemParameters = 0x00000008;
    private const uint JobObjectUiLimitDisplaySettings = 0x00000010;
    private const uint JobObjectUiLimitGlobalAtoms = 0x00000020;
    private const uint JobObjectUiLimitDesktop = 0x00000040;
    private const uint JobObjectUiLimitExitWindows = 0x00000080;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const int JobObjectBasicUiRestrictionsClass = 4;

    private readonly SafeWaitHandle handle;

    private WindowsJobObject(SafeWaitHandle handle)
    {
        this.handle = handle;
    }

    internal static WindowsJobObject CreateSupervisor()
    {
        var job = Create();
        job.Configure(new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JobObjectLimitKillOnJobClose | JobObjectLimitBreakawayOk,
            },
        });
        return job;
    }

    internal static WindowsJobObject CreateCommand(ResourceLimits limits)
    {
        var flags = JobObjectLimitKillOnJobClose |
                    JobObjectLimitDieOnUnhandledException |
                    JobObjectLimitActiveProcess;
        var information = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                ActiveProcessLimit = checked((uint)limits.MaxProcesses),
            },
        };
        if (limits.MaxMemoryBytes is { } memory)
        {
            flags |= JobObjectLimitJobMemory;
            information.JobMemoryLimit = checked((UIntPtr)(ulong)memory);
        }
        if (limits.MaxCpuTimeMs is { } cpu)
        {
            flags |= JobObjectLimitJobTime;
            information.BasicLimitInformation.PerJobUserTimeLimit = checked(cpu * 10_000L);
        }
        information.BasicLimitInformation.LimitFlags = flags;
        var job = Create();
        job.Configure(information);
        job.ConfigureUiRestrictions();
        return job;
    }

    internal bool Contains(SafeWaitHandle process)
    {
        if (!IsProcessInJob(process, handle, out var result))
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "IsProcessInJob failed",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
        return result;
    }

    internal IntPtr DangerousGetHandle() => handle.DangerousGetHandle();

    internal void Terminate(uint exitCode)
    {
        if (!TerminateJobObject(handle, exitCode))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != 6)
            {
                throw new NativeExecutionException(
                    "protocol_failure",
                    "TerminateJobObject failed",
                    innerException: new Win32Exception(error));
            }
        }
    }

    public void Dispose() => handle.Dispose();

    private static WindowsJobObject Create()
    {
        var handle = CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid)
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "CreateJobObject failed",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
        return new WindowsJobObject(handle);
    }

    private void Configure(JobObjectExtendedLimitInformation information)
    {
        var size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformationClass,
                    buffer,
                    checked((uint)size)))
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "SetInformationJobObject failed",
                    innerException: new Win32Exception(Marshal.GetLastWin32Error()));
            }
            var configured = Query<JobObjectExtendedLimitInformation>(
                JobObjectExtendedLimitInformationClass,
                "QueryInformationJobObject(limits) failed");
            if (configured.BasicLimitInformation.LimitFlags != information.BasicLimitInformation.LimitFlags ||
                configured.BasicLimitInformation.ActiveProcessLimit != information.BasicLimitInformation.ActiveProcessLimit ||
                configured.BasicLimitInformation.PerJobUserTimeLimit != information.BasicLimitInformation.PerJobUserTimeLimit ||
                configured.JobMemoryLimit != information.JobMemoryLimit)
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "Job Object limits did not round-trip exactly");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private void ConfigureUiRestrictions()
    {
        var information = new JobObjectBasicUiRestrictions
        {
            UiRestrictionsClass =
                JobObjectUiLimitHandles |
                JobObjectUiLimitReadClipboard |
                JobObjectUiLimitWriteClipboard |
                JobObjectUiLimitSystemParameters |
                JobObjectUiLimitDisplaySettings |
                JobObjectUiLimitGlobalAtoms |
                JobObjectUiLimitDesktop |
                JobObjectUiLimitExitWindows,
        };
        var size = Marshal.SizeOf<JobObjectBasicUiRestrictions>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(
                    handle,
                    JobObjectBasicUiRestrictionsClass,
                    buffer,
                    checked((uint)size)))
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "SetInformationJobObject(UI restrictions) failed",
                    innerException: new Win32Exception(Marshal.GetLastWin32Error()));
            }
            var configured = Query<JobObjectBasicUiRestrictions>(
                JobObjectBasicUiRestrictionsClass,
                "QueryInformationJobObject(UI restrictions) failed");
            if (configured.UiRestrictionsClass != information.UiRestrictionsClass)
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "Job Object UI restrictions did not round-trip exactly");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private T Query<T>(int informationClass, string message) where T : struct
    {
        var size = Marshal.SizeOf<T>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(
                    handle,
                    informationClass,
                    buffer,
                    checked((uint)size),
                    out var returnedLength) ||
                returnedLength != size)
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    message,
                    innerException: new Win32Exception(Marshal.GetLastWin32Error()));
            }
            return Marshal.PtrToStructure<T>(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicUiRestrictions
    {
        internal uint UiRestrictionsClass;
    }

    [DllImport("Kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeWaitHandle CreateJobObject(IntPtr jobAttributes, string? name);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        SafeWaitHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        SafeWaitHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnedLength);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(
        SafeWaitHandle process,
        SafeWaitHandle job,
        [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(SafeWaitHandle job, uint exitCode);
}
