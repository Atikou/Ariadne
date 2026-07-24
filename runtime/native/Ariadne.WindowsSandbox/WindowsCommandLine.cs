using System.Text;

namespace Ariadne.WindowsSandbox;

internal sealed record WindowsCommandSpec(string Application, string CommandLine);

internal static class WindowsCommandLine
{
    private const int MaxCreateProcessCommandLine = 32_766;
    private const int MaxCmdCommandLine = 8_191;

    private static readonly HashSet<string> DirectExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe",
        ".com",
    };

    private static readonly HashSet<string> ScriptExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".cmd",
        ".bat",
    };

    internal static WindowsCommandSpec Resolve(
        InvocationRequest invocation,
        string cwd,
        IReadOnlyDictionary<string, string> environment)
    {
        var cmd = ResolveCommandProcessor(environment);
        if (invocation.Kind == "shell")
        {
            var commandLine = BuildCmdCommandLine(cmd, invocation.Command!);
            RequireLength(commandLine, MaxCmdCommandLine, "shell command line");
            return new WindowsCommandSpec(cmd, commandLine);
        }

        var executable = ResolveExecutable(invocation.File!, cwd, environment);
        var extension = Path.GetExtension(executable);
        var arguments = invocation.Args ?? [];
        if (ScriptExtensions.Contains(extension))
        {
            var scriptCommand = string.Join(
                ' ',
                new[] { QuoteArgument(executable) }.Concat(arguments.Select(QuoteArgument)));
            var commandLine = BuildCmdCommandLine(cmd, scriptCommand);
            RequireLength(commandLine, MaxCmdCommandLine, "script command line");
            return new WindowsCommandSpec(cmd, commandLine);
        }
        if (!DirectExtensions.Contains(extension))
        {
            throw new RequestException($"unsupported executable extension: {extension}");
        }

        var directCommandLine = string.Join(
            ' ',
            new[] { QuoteArgument(executable) }.Concat(arguments.Select(QuoteArgument)));
        RequireLength(directCommandLine, MaxCreateProcessCommandLine, "file command line");
        return new WindowsCommandSpec(executable, directCommandLine);
    }

    internal static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.All(character =>
                !char.IsWhiteSpace(character) && character != '"'))
        {
            return value;
        }

        var result = new StringBuilder(value.Length + 2);
        result.Append('"');
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', checked(backslashes * 2 + 1));
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', checked(backslashes * 2));
        result.Append('"');
        return result.ToString();
    }

    private static string ResolveCommandProcessor(IReadOnlyDictionary<string, string> environment)
    {
        if (!environment.TryGetValue("SYSTEMROOT", out var systemRoot) || string.IsNullOrWhiteSpace(systemRoot))
        {
            throw new NativeExecutionException("process_start_failure", "sandbox environment has no SYSTEMROOT");
        }
        var cmd = Path.Combine(systemRoot, "System32", "cmd.exe");
        if (!File.Exists(cmd))
        {
            throw new NativeExecutionException("process_start_failure", "System32 command processor is unavailable");
        }
        return WindowsPathResolver.Canonicalize(cmd);
    }

    private static string ResolveExecutable(
        string file,
        string cwd,
        IReadOnlyDictionary<string, string> environment)
    {
        var extensions = CandidateExtensions(file, environment);
        if (Path.IsPathFullyQualified(file) ||
            file.Contains(Path.DirectorySeparatorChar) ||
            file.Contains(Path.AltDirectorySeparatorChar))
        {
            var explicitPath = Path.IsPathFullyQualified(file) ? file : Path.GetFullPath(file, cwd);
            foreach (var extension in extensions)
            {
                var candidate = explicitPath + extension;
                if (File.Exists(candidate)) return WindowsPathResolver.Canonicalize(candidate);
            }
            throw new RequestException("invocation.file does not reference an executable file");
        }

        if (!environment.TryGetValue("PATH", out var pathValue))
        {
            throw new RequestException("sandbox account PATH is unavailable");
        }
        foreach (var directoryValue in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var directory = directoryValue.Trim().Trim('"');
            if (directory.Length == 0) continue;
            string basePath;
            try
            {
                basePath = Path.Combine(
                    Path.IsPathFullyQualified(directory) ? directory : Path.GetFullPath(directory, cwd),
                    file);
            }
            catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
            {
                continue;
            }
            foreach (var extension in extensions)
            {
                var candidate = basePath + extension;
                if (File.Exists(candidate)) return WindowsPathResolver.Canonicalize(candidate);
            }
        }
        throw new RequestException($"executable was not found on the sandbox account PATH: {file}");
    }

    private static IReadOnlyList<string> CandidateExtensions(
        string file,
        IReadOnlyDictionary<string, string> environment)
    {
        var extension = Path.GetExtension(file);
        if (!string.IsNullOrEmpty(extension))
        {
            return DirectExtensions.Contains(extension) || ScriptExtensions.Contains(extension)
                ? [string.Empty]
                : throw new RequestException($"unsupported executable extension: {extension}");
        }

        var pathExtensions = environment.TryGetValue("PATHEXT", out var configured)
            ? configured.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            : [".COM", ".EXE", ".BAT", ".CMD"];
        var allowed = pathExtensions
            .Select(value => value.StartsWith('.') ? value : $".{value}")
            .Where(value => DirectExtensions.Contains(value) || ScriptExtensions.Contains(value))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return allowed.Length > 0 ? allowed : [".exe", ".com", ".cmd", ".bat"];
    }

    private static string BuildCmdCommandLine(string cmd, string command) =>
        $"{QuoteArgument(cmd)} /d /s /c \"{command}\"";

    private static void RequireLength(string commandLine, int maximum, string fieldName)
    {
        if (commandLine.Length > maximum)
        {
            throw new RequestException($"{fieldName} exceeds the Windows process limit");
        }
    }
}
