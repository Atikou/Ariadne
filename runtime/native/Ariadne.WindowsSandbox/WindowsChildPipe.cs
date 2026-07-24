using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsChildPipe : IDisposable
{
    private const uint HandleFlagInherit = 0x00000001;

    private WindowsChildPipe(SafeFileHandle parentEnd, SafeFileHandle childEnd)
    {
        ParentEnd = parentEnd;
        ChildEnd = childEnd;
    }

    internal SafeFileHandle ParentEnd { get; }
    internal SafeFileHandle ChildEnd { get; }

    internal static WindowsChildPipe CreateForChildInput()
    {
        Create(out var read, out var write);
        MakeNonInheritable(write);
        return new WindowsChildPipe(write, read);
    }

    internal static WindowsChildPipe CreateForChildOutput()
    {
        Create(out var read, out var write);
        MakeNonInheritable(read);
        return new WindowsChildPipe(read, write);
    }

    internal FileStream OpenParentStream(FileAccess access) =>
        new(ParentEnd, access, 16_384, isAsync: false);

    internal void CloseChildEnd() => ChildEnd.Dispose();

    public void Dispose()
    {
        ParentEnd.Dispose();
        ChildEnd.Dispose();
    }

    private static void Create(out SafeFileHandle read, out SafeFileHandle write)
    {
        var attributes = new SecurityAttributes
        {
            Length = Marshal.SizeOf<SecurityAttributes>(),
            InheritHandle = true,
        };
        if (!CreatePipe(out read, out write, ref attributes, 0))
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "CreatePipe failed",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
    }

    private static void MakeNonInheritable(SafeFileHandle handle)
    {
        if (!SetHandleInformation(handle, HandleFlagInherit, 0))
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "SetHandleInformation failed",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
    }

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out SafeFileHandle readPipe,
        out SafeFileHandle writePipe,
        ref SecurityAttributes pipeAttributes,
        uint size);

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(
        SafeFileHandle handle,
        uint mask,
        uint flags);
}
