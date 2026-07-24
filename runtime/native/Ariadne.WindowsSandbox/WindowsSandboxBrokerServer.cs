using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsSandboxBrokerServer
{
    private const int MaxConcurrentExecutions = 4;
    private readonly string stateRoot;
    private readonly SecurityIdentifier ownerSid;
    private readonly SemaphoreSlim executionSlots = new(MaxConcurrentExecutions, MaxConcurrentExecutions);

    internal WindowsSandboxBrokerServer(string stateRoot, SecurityIdentifier ownerSid)
    {
        this.stateRoot = PathPolicy.NormalizeAbsolute(stateRoot, "--state-root");
        this.ownerSid = ownerSid;
    }

    internal async Task RunAsync(CancellationToken cancellationToken)
    {
        var active = new HashSet<Task>();
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var pipe = WindowsSandboxBrokerProtocol.CreateServer(stateRoot, ownerSid);
                try
                {
                    await pipe.WaitForConnectionAsync(cancellationToken);
                }
                catch
                {
                    pipe.Dispose();
                    throw;
                }
                var task = HandleConnectionAsync(pipe, cancellationToken);
                lock (active) active.Add(task);
                _ = task.ContinueWith(
                    completed =>
                    {
                        lock (active) active.Remove(completed);
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        finally
        {
            Task[] remaining;
            lock (active) remaining = active.ToArray();
            await Task.WhenAll(remaining.Select(IgnoreFailureAsync));
        }
    }

    private async Task HandleConnectionAsync(NamedPipeServerStream pipe, CancellationToken serviceCancellation)
    {
        using (pipe)
        {
            await executionSlots.WaitAsync(serviceCancellation);
            string? executionId = null;
            try
            {
                EnsureLocalClient(pipe);
                ExecutionAuthorization? authorization = null;
                var request = await WindowsSandboxBrokerProtocol.ReadRequestAsync(pipe, serviceCancellation);
                executionId = request.ExecutionId;
                pipe.RunAsClient(() =>
                {
                    using var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
                    if (!string.Equals(identity.User?.Value, ownerSid.Value, StringComparison.Ordinal))
                    {
                        throw new NativeExecutionException("permission_denied", "broker client identity mismatch");
                    }
                    authorization = SandboxControlPlane.AuthorizeExecution(request, stateRoot);
                });
                if (authorization is null)
                {
                    throw new NativeExecutionException("protocol_failure", "broker authorization was not produced");
                }
                await ExecuteAsync(pipe, request, authorization, serviceCancellation);
            }
            catch (Exception error)
            {
                TryWriteError(pipe, executionId, error);
            }
            finally
            {
                executionSlots.Release();
            }
        }
    }

    private static async Task ExecuteAsync(
        NamedPipeServerStream pipe,
        ExecutionRequest request,
        ExecutionAuthorization authorization,
        CancellationToken serviceCancellation)
    {
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false, true), 16 * 1024, leaveOpen: true)
        {
            AutoFlush = true,
        };
        var protocol = new NativeProtocolWriter(writer);
        protocol.Authorized(
            request.ExecutionId,
            authorization.Policy.Digest,
            request.NetworkMode == "offline" ? "offline" : "online",
            Program.HashAccountSid(authorization.AccountSid),
            authorization.WriteScope);

        using var stdoutPipe = WindowsChildPipe.CreateForChildOutput();
        using var stderrPipe = WindowsChildPipe.CreateForChildOutput();
        using var executionCancellation = CancellationTokenSource.CreateLinkedTokenSource(serviceCancellation);
        using var stdout = stdoutPipe.OpenParentStream(FileAccess.Read);
        using var stderr = stderrPipe.OpenParentStream(FileAccess.Read);
        var stdoutCopy = CopyRunnerOutputAsync(stdout, pipe, executionCancellation);
        var stderrDrain = DrainRunnerErrorAsync(stderr, executionCancellation.Token);
        var disconnect = MonitorClientAsync(pipe, executionCancellation);
        try
        {
            await NativeExecutionSupervisor.RunBatchAsync(
                request,
                authorization,
                stdoutPipe,
                stderrPipe,
                executionCancellation.Token);
            await stdoutCopy;
            await stderrDrain;
        }
        finally
        {
            executionCancellation.Cancel();
            await IgnoreFailureAsync(disconnect);
            await IgnoreFailureAsync(stdoutCopy);
            await IgnoreFailureAsync(stderrDrain);
        }
    }

    private static async Task CopyRunnerOutputAsync(
        Stream source,
        Stream destination,
        CancellationTokenSource executionCancellation)
    {
        try
        {
            await source.CopyToAsync(destination, 64 * 1024, executionCancellation.Token);
            await destination.FlushAsync(executionCancellation.Token);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException)
        {
            executionCancellation.Cancel();
            if (error is IOException) throw;
        }
    }

    private static async Task DrainRunnerErrorAsync(Stream source, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        while (await source.ReadAsync(buffer, cancellationToken) > 0)
        {
        }
    }

    private static async Task MonitorClientAsync(
        Stream pipe,
        CancellationTokenSource executionCancellation)
    {
        var probe = new byte[1];
        try
        {
            var read = await pipe.ReadAsync(probe, executionCancellation.Token);
            if (read >= 0) executionCancellation.Cancel();
        }
        catch (Exception error) when (error is IOException or OperationCanceledException)
        {
            if (error is IOException) executionCancellation.Cancel();
        }
    }

    private static void EnsureLocalClient(NamedPipeServerStream pipe)
    {
        var capacity = 256u;
        var name = new StringBuilder(checked((int)capacity));
        if (!GetNamedPipeClientComputerName(pipe.SafePipeHandle, name, capacity))
        {
            throw new NativeExecutionException(
                "permission_denied",
                "broker client computer identity unavailable",
                innerException: new Win32Exception(Marshal.GetLastWin32Error()));
        }
        var client = name.ToString().TrimStart('\\');
        if (!string.Equals(client, Environment.MachineName, StringComparison.OrdinalIgnoreCase))
        {
            throw new NativeExecutionException("permission_denied", "remote broker clients are not allowed");
        }
    }

    private static void TryWriteError(NamedPipeServerStream pipe, string? executionId, Exception error)
    {
        try
        {
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false, true), 16 * 1024, leaveOpen: true)
            {
                AutoFlush = true,
            };
            var protocol = new NativeProtocolWriter(writer);
            switch (error)
            {
                case NativeExecutionException native:
                    protocol.Error(executionId, native.Code, native.Message, native.Retryable);
                    break;
                case RequestException request:
                    protocol.Error(executionId, "invalid_request", request.Message, false);
                    break;
                case OperationCanceledException:
                    protocol.Error(executionId, "cancelled", "sandbox broker execution was cancelled", false);
                    break;
                default:
                    protocol.Error(executionId, "protocol_failure", "sandbox broker failed", false);
                    break;
            }
        }
        catch (Exception writeError) when (writeError is IOException or ObjectDisposedException)
        {
        }
    }

    private static async Task IgnoreFailureAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException)
        {
        }
    }

    [DllImport("Kernel32.dll", EntryPoint = "GetNamedPipeClientComputerNameW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientComputerName(
        Microsoft.Win32.SafeHandles.SafePipeHandle pipe,
        StringBuilder clientComputerName,
        uint clientComputerNameLength);
}
