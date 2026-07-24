using System.ServiceProcess;
using System.Security.Principal;

namespace Ariadne.WindowsSandbox;

internal sealed class WindowsSandboxBrokerService : ServiceBase
{
    private readonly string stateRoot;
    private readonly SecurityIdentifier ownerSid;
    private CancellationTokenSource? shutdown;
    private Task? serverTask;

    internal WindowsSandboxBrokerService(string stateRoot, SecurityIdentifier ownerSid)
    {
        this.stateRoot = PathPolicy.NormalizeAbsolute(stateRoot, "--state-root");
        this.ownerSid = ownerSid;
        ServiceName = WindowsSandboxBrokerServiceManager.ServiceName(this.stateRoot, ownerSid);
        CanStop = true;
        CanShutdown = true;
        AutoLog = false;
    }

    internal static int Run(IReadOnlyList<string> args)
    {
        if (args.Count != 5 || args[1] != "--state-root" || args[3] != "--owner-sid")
        {
            throw new RequestException("expected broker-service --state-root <absolute-path> --owner-sid <sid>");
        }
        var ownerSid = new SecurityIdentifier(args[4]);
        ServiceBase.Run(new WindowsSandboxBrokerService(args[2], ownerSid));
        return 0;
    }

    protected override void OnStart(string[] args)
    {
        using var identity = WindowsIdentity.GetCurrent();
        if (!identity.IsSystem) throw new SetupException("broker_service_identity_invalid");
        HelperPublisherTrust.EnsureCurrentExecutableTrusted();
        StateStorage.ValidateSecureRootLocation(stateRoot);
        shutdown = new CancellationTokenSource();
        serverTask = new WindowsSandboxBrokerServer(stateRoot, ownerSid).RunAsync(shutdown.Token);
        _ = serverTask.ContinueWith(
            completed =>
            {
                if (!completed.IsFaulted) return;
                ExitCode = 1067;
                try
                {
                    Stop();
                }
                catch (InvalidOperationException)
                {
                }
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    protected override void OnStop() => StopServer();

    protected override void OnShutdown() => StopServer();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            StopServer();
            shutdown?.Dispose();
        }
        base.Dispose(disposing);
    }

    private void StopServer()
    {
        var cancellation = shutdown;
        var task = serverTask;
        if (cancellation is null || task is null) return;
        cancellation.Cancel();
        if (!task.Wait(TimeSpan.FromSeconds(30)))
        {
            throw new System.TimeoutException("sandbox broker did not stop within its service deadline");
        }
        serverTask = null;
    }
}
