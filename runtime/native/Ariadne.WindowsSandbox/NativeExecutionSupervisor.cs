using System.Text;
using System.Text.Json;
using System.Security.Principal;

namespace Ariadne.WindowsSandbox;

internal static class NativeExecutionSupervisor
{
    private const uint SupervisorFailureExitCode = 125;

    internal static async Task RunBatchAsync(
        ExecutionRequest request,
        ExecutionAuthorization authorization,
        WindowsChildPipe stdoutPipe,
        WindowsChildPipe stderrPipe,
        CancellationToken cancellationToken)
    {
        var executable = RequireExecutable();
        var commandLine = BuildCommandLine(executable, authorization);
        using var inputPipe = WindowsChildPipe.CreateForChildInput();
        using var inputStream = inputPipe.OpenParentStream(FileAccess.Write);
        using var supervisorJob = WindowsJobObject.CreateSupervisor();
        using var token = authorization.UsePasswordOnce(password =>
            WindowsBatchLogon.Logon(authorization.AccountName, password));
        var filesystemCapability = new SecurityIdentifier(
            authorization.Manifest.FilesystemCapabilitySid ?? throw new NativeExecutionException(
                "setup_required",
                "filesystem capability is missing from the setup manifest"));
        var tempRoot = PathPolicy.NormalizeAbsolute(
            WindowsUserEnvironmentBlock.ReadRequiredVariable(token, "TEMP"),
            "sandboxAccount.TEMP");
        var lease = new SandboxArtifactLease
        {
            ExecutionId = request.ExecutionId,
            AccountSid = authorization.AccountSid,
            TempRoot = tempRoot,
            FilesystemCapabilitySid = filesystemCapability.Value,
            PolicyDigest = authorization.Policy.Digest,
        };
        var leaseStore = new SandboxArtifactLeaseStore(
            authorization.Policy.StateRoot,
            new SecurityIdentifier(authorization.Manifest.OwnerSid));
        leaseStore.RecoverAndRegister(token, lease);
        try
        {
            WindowsProcessHandles? runner = null;
            try
            {
                runner = WindowsProcessLauncher.StartBatchRunner(
                    token,
                    supervisorJob,
                    executable,
                    commandLine,
                    request.Cwd,
                    inputPipe.ChildEnd,
                    stdoutPipe.ChildEnd,
                    stderrPipe.ChildEnd);
            }
            finally
            {
                inputPipe.CloseChildEnd();
                stdoutPipe.CloseChildEnd();
                stderrPipe.CloseChildEnd();
            }

            using (runner)
            {
                await WriteRequestAsync(inputStream, request);
                var watchdog = checked(request.TimeoutMs + 30_000);
                var wait = Task.Run(() => runner.Wait(watchdog));
                var cancelled = Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                if (await Task.WhenAny(wait, cancelled) == cancelled)
                {
                    supervisorJob.Terminate(SupervisorFailureExitCode);
                    _ = await wait;
                    throw new NativeExecutionException("cancelled", "sandbox broker execution was cancelled");
                }
                if (!await wait)
                {
                    supervisorJob.Terminate(SupervisorFailureExitCode);
                    if (!runner.Wait(10_000))
                    {
                        throw new NativeExecutionException(
                            "protocol_failure",
                            "restricted runner did not terminate after its supervisor Job was stopped");
                    }
                    throw new NativeExecutionException(
                        "protocol_failure",
                        "restricted runner exceeded its lifecycle watchdog");
                }
                if (runner.ExitCode() != 0)
                {
                    throw new NativeExecutionException(
                        "protocol_failure",
                        "restricted runner exited without a valid terminal protocol event");
                }
            }
        }
        finally
        {
            var cleaned = false;
            try
            {
                WindowsSandboxArtifactCleaner.Delete(token, lease);
                cleaned = true;
            }
            finally
            {
                if (cleaned) leaseStore.Complete(lease);
                else leaseStore.Abandon(lease);
            }
        }
    }

    private static string RequireExecutable()
    {
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
        {
            throw new NativeExecutionException("helper_unavailable", "native runner executable is unavailable");
        }
        return executable;
    }

    private static string BuildCommandLine(string executable, ExecutionAuthorization authorization) => string.Join(' ', new[]
    {
        WindowsCommandLine.QuoteArgument(executable),
        "run-restricted",
        "--expected-sid",
        WindowsCommandLine.QuoteArgument(authorization.AccountSid),
        "--writer-sid",
        WindowsCommandLine.QuoteArgument(authorization.Manifest.WriterGroupSid),
        "--restriction-sid",
        WindowsCommandLine.QuoteArgument(authorization.RestrictionSid),
        "--filesystem-capability-sid",
        WindowsCommandLine.QuoteArgument(
            authorization.Manifest.FilesystemCapabilitySid ?? throw new NativeExecutionException(
                "setup_required",
                "filesystem capability is missing from the setup manifest")),
    });

    private static async Task WriteRequestAsync(Stream stream, ExecutionRequest request)
    {
        var json = JsonSerializer.Serialize(request, JsonProtocol.Options);
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        try
        {
            await stream.WriteAsync(bytes);
            await stream.FlushAsync();
        }
        catch (IOException)
        {
            // The runner reports its own startup failure through the inherited protocol output.
        }
    }

}
