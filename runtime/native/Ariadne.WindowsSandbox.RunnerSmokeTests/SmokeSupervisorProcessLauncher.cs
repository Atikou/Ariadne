using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Ariadne.WindowsSandbox;
using Microsoft.Win32.SafeHandles;

internal static class SmokeSupervisorProcessLauncher
{
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const ulong ProcThreadAttributeHandleList = 0x00020002;
    private const ulong ProcThreadAttributeJobList = 0x0002000D;

    internal static WindowsProcessHandles Start(
        WindowsJobObject job,
        string executable,
        string commandLine,
        string cwd,
        SafeFileHandle stdin,
        SafeFileHandle stdout,
        SafeFileHandle stderr)
    {
        var handles = new[]
        {
            stdin.DangerousGetHandle(),
            stdout.DangerousGetHandle(),
            stderr.DangerousGetHandle(),
        }.Distinct().ToArray();
        var required = IntPtr.Zero;
        _ = InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref required);
        if (required == IntPtr.Zero)
        {
            throw Failure("InitializeProcThreadAttributeList size failed");
        }

        var attributes = Marshal.AllocHGlobal(required);
        var handleList = Marshal.AllocHGlobal(checked(handles.Length * IntPtr.Size));
        var jobList = Marshal.AllocHGlobal(IntPtr.Size);
        var initialized = false;
        ProcessInformation information;
        try
        {
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref required))
            {
                throw Failure("InitializeProcThreadAttributeList failed");
            }
            initialized = true;
            for (var index = 0; index < handles.Length; index++)
            {
                Marshal.WriteIntPtr(handleList, checked(index * IntPtr.Size), handles[index]);
            }
            if (!UpdateProcThreadAttribute(
                    attributes,
                    0,
                    new UIntPtr(ProcThreadAttributeHandleList),
                    handleList,
                    new IntPtr(checked(handles.Length * IntPtr.Size)),
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                throw Failure("UpdateProcThreadAttribute(handle list) failed");
            }
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
                throw Failure("UpdateProcThreadAttribute(job list) failed");
            }

            var startup = new StartupInformationEx
            {
                StartupInformation = new StartupInformation
                {
                    Size = Marshal.SizeOf<StartupInformationEx>(),
                    Flags = StartfUseStdHandles,
                    StandardInput = stdin.DangerousGetHandle(),
                    StandardOutput = stdout.DangerousGetHandle(),
                    StandardError = stderr.DangerousGetHandle(),
                },
                AttributeList = attributes,
            };
            var mutableCommandLine = new StringBuilder(commandLine);
            if (!CreateProcess(
                    executable,
                    mutableCommandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CreateSuspended | CreateNoWindow | ExtendedStartupInfoPresent,
                    IntPtr.Zero,
                    cwd,
                    ref startup,
                    out information))
            {
                throw Failure("CreateProcessW failed");
            }
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
            Marshal.FreeHGlobal(handleList);
            Marshal.FreeHGlobal(jobList);
        }

        var process = new WindowsProcessHandles(
            new SafeWaitHandle(information.Process, ownsHandle: true),
            new SafeWaitHandle(information.Thread, ownsHandle: true),
            checked((int)information.ProcessId));
        try
        {
            if (!job.Contains(process.Process))
            {
                throw new InvalidOperationException("smoke process was not assigned to the supervisor Job Object");
            }
            process.Resume();
            return process;
        }
        catch
        {
            try
            {
                process.TerminateAndWait(125, 10_000);
            }
            finally
            {
                process.Dispose();
            }
            throw;
        }
    }

    private static Win32Exception Failure(string message) =>
        new(Marshal.GetLastWin32Error(), message);

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
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInformationEx
    {
        internal StartupInformation StartupInformation;
        internal IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process;
        internal IntPtr Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [DllImport("Kernel32.dll", EntryPoint = "CreateProcessW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
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
