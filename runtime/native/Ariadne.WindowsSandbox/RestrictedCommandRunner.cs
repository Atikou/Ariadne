using System.Security.Principal;
using System.Text;

namespace Ariadne.WindowsSandbox;

internal static class RestrictedCommandRunner
{
    private const uint TimeoutExitCode = 124;
    private const uint ResidualProcessExitCode = 137;
    private static readonly SecurityIdentifier RestrictedCodeSid = new("S-1-5-12");

    internal static async Task<NativeExecutionResult> ExecuteAsync(
        ExecutionRequest request,
        RunnerIdentity expectedIdentity,
        INativeExecutionEventSink sink,
        TextReader? interactiveInput = null)
    {
        using var identity = VerifyIdentity(request, expectedIdentity);
        var isolation = BuildIsolation(request);
        SecurityIdentifier filesystemCapabilitySid;
        try
        {
            filesystemCapabilitySid = new SecurityIdentifier(expectedIdentity.FilesystemCapabilitySid);
        }
        catch (ArgumentException error)
        {
            throw new RequestException($"runner filesystem capability contains an invalid SID: {error.Message}");
        }
        var result = await ExecuteIsolatedAsync(
            request,
            expectedIdentity,
            filesystemCapabilitySid,
            isolation,
            sink,
            interactiveInput);
        sink.Result(request.ExecutionId, result);
        return result;
    }

    private static async Task<NativeExecutionResult> ExecuteIsolatedAsync(
        ExecutionRequest request,
        RunnerIdentity expectedIdentity,
        SecurityIdentifier filesystemCapabilitySid,
        NativeIsolation isolation,
        INativeExecutionEventSink sink,
        TextReader? interactiveInput)
    {
        using var appContainer = WindowsAppContainerProfile.CreateEphemeral(
            request.ExecutionId,
            filesystemCapabilitySid,
            request.NetworkMode != "offline");
        using var runtimeDirectory = WindowsRuntimeDirectory.Create(
            request.ExecutionId,
            filesystemCapabilitySid,
            appContainer.PackageSid);
        using var environment = RestrictedEnvironment.Create(
            request.Environment,
            request.Mode,
            request.NetworkMode,
            runtimeDirectory,
            request.Cwd);
        var command = WindowsCommandLine.Resolve(request.Invocation, request.Cwd, environment.Variables);
        var stdin = ExecutionValidator.DecodeStdin(request.StdinBase64);

        WindowsProcessLauncher.DisableStandardHandleInheritance();
        using var inputPipe = WindowsChildPipe.CreateForChildInput();
        using var outputPipe = WindowsChildPipe.CreateForChildOutput();
        using var errorPipe = WindowsChildPipe.CreateForChildOutput();
        using var inputStream = inputPipe.OpenParentStream(FileAccess.Write);
        using var outputStream = outputPipe.OpenParentStream(FileAccess.Read);
        using var errorStream = errorPipe.OpenParentStream(FileAccess.Read);
        var restrictionSid = new SecurityIdentifier(expectedIdentity.RestrictionSid);
        using var privateDesktop = WindowsPrivateDesktop.Create(appContainer.PackageSid);
        using var restrictedToken = WindowsRestrictedToken.Create(
            restrictionSid,
            privateDesktop.RestrictionSid,
            runtimeDirectory.RestrictionSid);
        using var job = WindowsJobObject.CreateCommand(request.ResourceLimits);

        WindowsProcessHandles? process = null;
        try
        {
            process = WindowsProcessLauncher.StartRestricted(
                restrictedToken.Handle,
                job,
                appContainer.PackageSid,
                appContainer.Capabilities,
                command.Application,
                command.CommandLine,
                request.Cwd,
                environment.Block,
                privateDesktop.StartupName,
                inputPipe.ChildEnd,
                outputPipe.ChildEnd,
                errorPipe.ChildEnd);
        }
        finally
        {
            inputPipe.CloseChildEnd();
            outputPipe.CloseChildEnd();
            errorPipe.CloseChildEnd();
        }

        using (process)
        {
            sink.Started(request.ExecutionId, process.ProcessId, isolation);
            var output = new BoundedOutput(request.MaxOutputBytes, request.ExecutionId, sink);
            var stdoutTask = output.DrainAsync(outputStream, isError: false);
            var stderrTask = output.DrainAsync(errorStream, isError: true);
            using var stdinCancellation = new CancellationTokenSource();
            var stdinTask = request.Interactive
                ? RelayInteractiveInputAsync(
                    interactiveInput ?? throw new NativeExecutionException(
                        "protocol_failure",
                        "interactive execution input is unavailable"),
                    inputStream,
                    request.ExecutionId,
                    stdinCancellation.Token)
                : WriteInputAsync(inputStream, stdin);

            var completed = await Task.Run(() => process.Wait(request.TimeoutMs));
            var timedOut = !completed;
            if (timedOut)
            {
                job.Terminate(TimeoutExitCode);
                if (!process.Wait(10_000))
                {
                    throw new NativeExecutionException(
                        "protocol_failure",
                        "command process did not terminate after its Job Object was stopped");
                }
            }
            var exitCode = process.ExitCode();
            job.Terminate(ResidualProcessExitCode);
            stdinCancellation.Cancel();
            await Task.WhenAll(stdoutTask, stderrTask);
            await IgnoreInputTerminationAsync(stdinTask);

            return new NativeExecutionResult
            {
                ExecutionId = request.ExecutionId,
                ExitCode = exitCode,
                Stdout = output.Stdout,
                Stderr = output.Stderr,
                TimedOut = timedOut,
                Truncated = output.Truncated,
                SpawnFailed = false,
                Isolation = isolation,
            };
        }
    }

    internal static NativeIsolation BuildIsolation(ExecutionRequest request) => new()
    {
        Mode = request.Mode,
        NetworkMode = request.NetworkMode,
        Account = request.NetworkMode == "offline" ? "offline" : "online",
        Firewall = request.NetworkMode == "offline",
        PrivateDesktop = true,
    };

    private static WindowsIdentity VerifyIdentity(
        ExecutionRequest request,
        RunnerIdentity expectedIdentity)
    {
        var current = WindowsIdentity.GetCurrent();
        var currentSid = current.User ?? throw new NativeExecutionException(
            "process_start_failure",
            "runner has no Windows account SID");
        SecurityIdentifier expectedAccountSid;
        SecurityIdentifier writerSid;
        SecurityIdentifier restrictionSid;
        try
        {
            expectedAccountSid = new SecurityIdentifier(expectedIdentity.ExpectedAccountSid);
            writerSid = new SecurityIdentifier(expectedIdentity.WriterGroupSid);
            restrictionSid = new SecurityIdentifier(expectedIdentity.RestrictionSid);
        }
        catch (ArgumentException error)
        {
            current.Dispose();
            throw new RequestException($"runner identity contains an invalid SID: {error.Message}");
        }
        if (!currentSid.Equals(expectedAccountSid))
        {
            current.Dispose();
            throw new NativeExecutionException("credential_failure", "runner account SID does not match authorization");
        }
        if (new WindowsPrincipal(current).IsInRole(WindowsBuiltInRole.Administrator))
        {
            current.Dispose();
            throw new NativeExecutionException("credential_failure", "runner account must not be an administrator");
        }
        if (expectedIdentity.RequireWriterMembership && !ContainsGroup(current, writerSid))
        {
            current.Dispose();
            throw new NativeExecutionException("credential_failure", "runner account is not in the writer group");
        }
        var requiredRestriction = request.WriteScope is not null
            ? EphemeralWriteScopeManager.DeriveCapabilitySid(
                request.WriteScope.ScopeId,
                PathPolicy.NormalizeAbsolute(request.WriteScope.Root, "writeScope.root"))
            : request.Mode == "workspace-write" ? writerSid : RestrictedCodeSid;
        if (!restrictionSid.Equals(requiredRestriction))
        {
            current.Dispose();
            throw new NativeExecutionException("process_start_failure", "restricted SID does not match sandbox mode");
        }
        return current;
    }

    private static bool ContainsGroup(WindowsIdentity identity, SecurityIdentifier expected)
    {
        if (identity.Groups is null) return false;
        foreach (var group in identity.Groups)
        {
            if (group.Equals(expected)) return true;
        }
        return false;
    }

    private static async Task WriteInputAsync(Stream stream, byte[] input)
    {
        try
        {
            if (input.Length > 0) await stream.WriteAsync(input);
            await stream.FlushAsync();
        }
        catch (IOException)
        {
            // The command may exit without reading stdin.
        }
        catch (ObjectDisposedException)
        {
            // The command may close stdin before the asynchronous write runs.
        }
        finally
        {
            stream.Dispose();
        }
    }

    private static async Task RelayInteractiveInputAsync(
        TextReader reader,
        Stream stream,
        string executionId,
        CancellationToken cancellationToken)
    {
        try
        {
            while (true)
            {
                var line = await Program.ReadBoundedLineAsync(
                    reader,
                    96 * 1024,
                    cancellationToken);
                var frame = Program.Deserialize<InteractiveInputFrame>(line);
                if (ExecutionValidator.IsInteractiveEnd(frame, executionId))
                {
                    stream.Dispose();
                    return;
                }
                var chunk = ExecutionValidator.DecodeInteractiveInput(frame, executionId);
                await stream.WriteAsync(chunk, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            // A child process may close stdin before its process handle signals exit.
        }
    }

    private static async Task IgnoreInputTerminationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
        catch (IOException)
        {
        }
    }

    private sealed class BoundedOutput(
        int maximumBytes,
        string executionId,
        INativeExecutionEventSink sink)
    {
        private readonly object gate = new();
        private readonly MemoryStream stdout = new();
        private readonly MemoryStream stderr = new();
        private int acceptedBytes;

        internal bool Truncated { get; private set; }
        internal string Stdout => Encoding.UTF8.GetString(stdout.ToArray());
        internal string Stderr => Encoding.UTF8.GetString(stderr.ToArray());

        internal async Task DrainAsync(Stream stream, bool isError)
        {
            var buffer = new byte[16_384];
            while (true)
            {
                var read = await stream.ReadAsync(buffer);
                if (read == 0) return;
                byte[] accepted;
                lock (gate)
                {
                    var count = Math.Min(read, Math.Max(0, maximumBytes - acceptedBytes));
                    if (count < read) Truncated = true;
                    acceptedBytes += count;
                    if (count == 0) continue;
                    accepted = buffer[..count];
                    (isError ? stderr : stdout).Write(accepted);
                }
                sink.Output(executionId, isError, accepted);
            }
        }
    }
}
