using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsUserEnvironmentBlock : IDisposable
{
    private const int MaxEnvironmentCharacters = 32_767;
    private IntPtr block;

    private WindowsUserEnvironmentBlock(IntPtr block)
    {
        this.block = block;
    }

    internal IntPtr Pointer => block;

    internal static WindowsUserEnvironmentBlock Create(SafeAccessTokenHandle token)
    {
        if (!CreateEnvironmentBlock(out var environment, token, false))
        {
            throw new NativeExecutionException(
                "process_start_failure",
                "CreateEnvironmentBlock for batch runner failed",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
        return new WindowsUserEnvironmentBlock(environment);
    }

    internal static string ReadRequiredVariable(SafeAccessTokenHandle token, string name)
    {
        using var environment = Create(token);
        var prefix = name + "=";
        var offset = 0;
        while (offset < MaxEnvironmentCharacters)
        {
            var entry = Marshal.PtrToStringUni(IntPtr.Add(environment.block, checked(offset * sizeof(char))))
                ?? throw new NativeExecutionException(
                    "process_start_failure",
                    "batch runner environment block is invalid");
            if (entry.Length == 0) break;
            if (entry.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                var value = entry[prefix.Length..];
                if (!string.IsNullOrWhiteSpace(value)) return value;
                break;
            }
            offset = checked(offset + entry.Length + 1);
        }
        throw new NativeExecutionException(
            "process_start_failure",
            $"batch runner environment is missing {name}");
    }

    public void Dispose()
    {
        if (block == IntPtr.Zero) return;
        _ = DestroyEnvironmentBlock(block);
        block = IntPtr.Zero;
    }

    [DllImport("Userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateEnvironmentBlock(
        out IntPtr environment,
        SafeAccessTokenHandle token,
        [MarshalAs(UnmanagedType.Bool)] bool inherit);

    [DllImport("Userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyEnvironmentBlock(IntPtr environment);
}
