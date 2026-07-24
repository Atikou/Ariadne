using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal static class WindowsPathResolver
{
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;

    internal static string Canonicalize(string fullPath)
    {
        var suffix = new Stack<string>();
        var existing = fullPath;
        while (!File.Exists(existing) && !Directory.Exists(existing))
        {
            var name = Path.GetFileName(existing);
            var parent = Path.GetDirectoryName(existing);
            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(parent))
            {
                throw new RequestException("path has no resolvable existing ancestor");
            }
            suffix.Push(name);
            existing = parent;
        }

        var canonical = ResolveExisting(existing);
        while (suffix.TryPop(out var segment)) canonical = Path.Combine(canonical, segment);
        return canonical;
    }

    private static string ResolveExisting(string path)
    {
        using var handle = CreateFile(
            path,
            0,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            throw new RequestException($"path cannot be resolved: {new Win32Exception(Marshal.GetLastWin32Error()).NativeErrorCode}");
        }
        return ResolveHandle(handle);
    }

    internal static string ResolveHandle(SafeFileHandle handle)
    {
        var capacity = 512;
        while (capacity <= 32_768)
        {
            var buffer = new StringBuilder(capacity);
            var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0)
            {
                throw new RequestException($"path cannot be resolved: {new Win32Exception(Marshal.GetLastWin32Error()).NativeErrorCode}");
            }
            if (length < buffer.Capacity)
            {
                var resolved = buffer.ToString();
                if (resolved.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase) ||
                    resolved.StartsWith("\\\\", StringComparison.Ordinal) && !resolved.StartsWith("\\\\?\\", StringComparison.Ordinal))
                {
                    throw new RequestException("UNC paths are not supported by the Windows sandbox");
                }
                if (!resolved.StartsWith("\\\\?\\", StringComparison.Ordinal))
                {
                    throw new RequestException("path did not resolve to a DOS device path");
                }
                var dosPath = resolved[4..];
                var root = Path.GetPathRoot(dosPath);
                return string.Equals(dosPath, root, StringComparison.OrdinalIgnoreCase)
                    ? dosPath
                    : Path.TrimEndingDirectorySeparator(dosPath);
            }
            capacity = checked((int)length + 1);
        }
        throw new RequestException("resolved path exceeds the protocol limit");
    }

    [DllImport("Kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("Kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        StringBuilder filePath,
        uint filePathSize,
        uint flags);
}
