using System.Text.Json;

namespace Ariadne.WindowsSandbox;

internal static class RestrictedRunnerEntry
{
    internal static async Task<int> RunAsync(IReadOnlyList<string> args)
    {
        ExecutionRequest? request = null;
        try
        {
            var identity = ParseIdentity(args);
            request = Program.Deserialize<ExecutionRequest>(await Program.ReadBoundedInputAsync());
            ExecutionValidator.Validate(request);
            await RestrictedCommandRunner.ExecuteAsync(request, identity, NativeProtocolWriter.Console);
            return 0;
        }
        catch (Exception error) when (error is RequestException or JsonException)
        {
            NativeProtocolWriter.Console.Error(request?.ExecutionId, "invalid_request", error.Message, false);
            return 0;
        }
        catch (NativeExecutionException error)
        {
            NativeProtocolWriter.Console.Error(request?.ExecutionId, error.Code, error.Message, error.Retryable);
            return 0;
        }
        catch (Exception error)
        {
            System.Console.Error.WriteLine(error);
            NativeProtocolWriter.Console.Error(
                request?.ExecutionId,
                "protocol_failure",
                "restricted runner failed",
                false);
            return 0;
        }
    }

    private static RunnerIdentity ParseIdentity(IReadOnlyList<string> args)
    {
        if (args.Count != 9 ||
            args[0] != "run-restricted" ||
            args[1] != "--expected-sid" ||
            args[3] != "--writer-sid" ||
            args[5] != "--restriction-sid" ||
            args[7] != "--filesystem-capability-sid")
        {
            throw new RequestException(
                "expected run-restricted --expected-sid <sid> --writer-sid <sid> --restriction-sid <sid> --filesystem-capability-sid <sid>");
        }
        return new RunnerIdentity(args[2], args[4], args[6], args[8], RequireWriterMembership: true);
    }
}
