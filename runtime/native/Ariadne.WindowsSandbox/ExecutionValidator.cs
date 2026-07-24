namespace Ariadne.WindowsSandbox;

internal static class ExecutionValidator
{
    private const int MaxEnvironmentCharacters = 256 * 1024;
    internal const int MaxStdinBytes = 1024 * 1024;
    internal const int MaxStdinBase64Characters = 4 * ((MaxStdinBytes + 2) / 3);

    internal static void Validate(ExecutionRequest request)
    {
        RequireText(request.ExecutionId, nameof(request.ExecutionId), 512);
        var cwd = PathPolicy.NormalizeAbsolute(request.Cwd, nameof(request.Cwd));
        var workspaceRoot = PathPolicy.NormalizeAbsolute(request.WorkspaceRoot, nameof(request.WorkspaceRoot));
        if (!Directory.Exists(workspaceRoot))
        {
            throw new RequestException("workspaceRoot must reference an existing directory");
        }
        if (request.Mode is not ("read-only" or "workspace-write"))
        {
            throw new RequestException("native helper does not accept danger-full-access mode");
        }
        if (request.WritableRoots.Count > 64 ||
            request.ToolReadRoots.Count > 64 ||
            request.ReadOnlySubpaths.Count > 64)
        {
            throw new RequestException("sandbox path lists must contain at most 64 entries");
        }
        if (request.WriteScope is not null)
        {
            ValidateWriteScope(request.WriteScope, request.Mode, workspaceRoot, cwd);
        }
        else if (!PathPolicy.IsSameOrDescendant(cwd, workspaceRoot) &&
                 !request.WritableRoots.Select(path => PathPolicy.NormalizeAbsolute(path, nameof(request.WritableRoots)))
                     .Any(root => PathPolicy.IsSameOrDescendant(cwd, root)))
        {
            throw new RequestException("cwd must be inside workspaceRoot or writableRoots");
        }
        if (request.NetworkMode is not ("offline" or "online-approved"))
        {
            throw new RequestException("networkMode is invalid");
        }
        if (request.TimeoutMs is <= 0 or > 86_400_000)
        {
            throw new RequestException("timeoutMs is out of range");
        }
        if (request.MaxOutputBytes is <= 0 or > 67_108_864)
        {
            throw new RequestException("maxOutputBytes is out of range");
        }
        if (request.ResourceLimits.MaxProcesses is < 1 or > 128)
        {
            throw new RequestException("maxProcesses is out of range");
        }
        if (request.ResourceLimits.MaxMemoryBytes is { } memory && memory is < 67_108_864 or > 17_179_869_184)
        {
            throw new RequestException("maxMemoryBytes is out of range");
        }
        if (request.ResourceLimits.MaxCpuTimeMs is { } cpu && cpu is <= 0 or > 86_400_000)
        {
            throw new RequestException("maxCpuTimeMs is out of range");
        }
        if (request.Environment.Count > 256 || request.Environment.Any(pair =>
                string.IsNullOrWhiteSpace(pair.Key) ||
                pair.Key.Length > 128 ||
                pair.Value.Length > 32_768 ||
                pair.Key.Contains('=') ||
                pair.Key.Contains('\0') ||
                pair.Value.Contains('\0') ||
                !RestrictedEnvironment.IsCallerVariableAllowed(pair.Key)) ||
            request.Environment.Sum(pair => pair.Key.Length + pair.Value.Length + 2) > MaxEnvironmentCharacters)
        {
            throw new RequestException("environment contains an invalid entry");
        }
        ValidateInvocation(request.Invocation);
        _ = DecodeStdin(request.StdinBase64);
    }

    internal static byte[] DecodeStdin(string? stdinBase64)
    {
        if (stdinBase64 is null)
        {
            return [];
        }
        if (stdinBase64.Length > MaxStdinBase64Characters)
        {
            throw new RequestException("stdinBase64 exceeds the 1 MiB decoded input limit");
        }
        byte[] decoded;
        try
        {
            decoded = Convert.FromBase64String(stdinBase64);
        }
        catch (FormatException)
        {
            throw new RequestException("stdinBase64 is invalid");
        }
        if (decoded.Length > MaxStdinBytes ||
            !string.Equals(Convert.ToBase64String(decoded), stdinBase64, StringComparison.Ordinal))
        {
            throw new RequestException("stdinBase64 must be canonical Base64 within the 1 MiB decoded input limit");
        }
        return decoded;
    }

    private static void ValidateWriteScope(
        WriteScopeRequest writeScope,
        string mode,
        string workspaceRoot,
        string cwd)
    {
        if (mode != "workspace-write")
        {
            throw new RequestException("writeScope requires workspace-write mode");
        }
        if (writeScope.ScopeId.Length != 32 ||
            writeScope.ScopeId.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new RequestException("writeScope.scopeId must be 32 lowercase hexadecimal characters");
        }
        var scopeRoot = PathPolicy.NormalizeAbsolute(writeScope.Root, "writeScope.root");
        if (!Directory.Exists(scopeRoot))
        {
            throw new RequestException("writeScope.root must reference an existing directory");
        }
        if (!PathPolicy.IsSameOrDescendant(scopeRoot, workspaceRoot) ||
            PathPolicy.PathEquals(scopeRoot, workspaceRoot))
        {
            throw new RequestException("writeScope.root must be strictly inside workspaceRoot");
        }
        if (!PathPolicy.IsSameOrDescendant(cwd, scopeRoot))
        {
            throw new RequestException("cwd must be inside writeScope.root");
        }
    }

    private static void ValidateInvocation(InvocationRequest invocation)
    {
        if (invocation.Kind == "file")
        {
            RequireText(invocation.File, "invocation.file", 32_768);
            if (invocation.Command is not null || invocation.Args is null || invocation.Args.Count > 4_096 ||
                invocation.Args.Any(argument => argument.Length > 32_768 || argument.Contains('\0')) ||
                invocation.Args.Sum(argument => argument.Length + 3L) > 30_000)
            {
                throw new RequestException("file invocation is invalid");
            }
            return;
        }
        if (invocation.Kind == "shell")
        {
            RequireText(invocation.Command, "invocation.command", 7_500);
            if (invocation.File is not null || invocation.Args is not null)
            {
                throw new RequestException("shell invocation is invalid");
            }
            return;
        }
        throw new RequestException("invocation.kind is invalid");
    }

    private static void RequireText(string? value, string fieldName, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maxLength || value.Contains('\0'))
        {
            throw new RequestException($"{fieldName} must be non-empty and at most {maxLength} characters");
        }
    }
}
