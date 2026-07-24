using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Ariadne.WindowsSandbox;

internal static class Program
{
    private const int MaxInputCharacters = WindowsSandboxBrokerProtocol.MaxRequestBytes;

    public static async Task<int> Main(string[] args)
    {
        var command = args.FirstOrDefault();
        if (command == "setup-elevated") return SetupElevation.RunElevated(args);
        if (command == "broker-service") return WindowsSandboxBrokerService.Run(args);
        if (command == "run-restricted")
        {
            if (!OperatingSystem.IsWindows())
            {
                WriteUnsupported(command);
                return 0;
            }
            return await RestrictedRunnerEntry.RunAsync(args);
        }
        string? executionId = null;
        try
        {
            var stateRoot = ParseStateRoot(args);
            if (!OperatingSystem.IsWindows())
            {
                WriteUnsupported(command);
                return 0;
            }
            var input = await ReadBoundedInputAsync();
            switch (command)
            {
                case "status":
                    WriteJson(SandboxControlPlane.GetStatus(Deserialize<SetupRequest>(input), stateRoot));
                    return 0;
                case "setup":
                    WriteJson(SetupService.Apply(Deserialize<SetupRequest>(input), stateRoot));
                    return 0;
                case "execute":
                    var request = Deserialize<ExecutionRequest>(input);
                    executionId = request.ExecutionId;
                    ExecutionValidator.Validate(request);
                    await WindowsSandboxBrokerClient.RunAsync(request, stateRoot);
                    return 0;
                default:
                    throw new RequestException("command must be status, setup, or execute");
            }
        }
        catch (Exception error) when (error is RequestException or JsonException)
        {
            if (command == "execute")
            {
                WriteProtocolError(executionId, "invalid_request", error.Message, false);
            }
            else
            {
                WriteJson(new StatusResponse { Status = "error", Reason = $"invalid_request:{error.Message}" });
            }
            return 0;
        }
        catch (SetupException error)
        {
            if (command == "execute")
            {
                WriteProtocolError(executionId, "setup_required", error.Code, false);
            }
            else
            {
                WriteJson(new StatusResponse { Status = "error", Reason = $"setup_failed:{error.Code}" });
            }
            return 0;
        }
        catch (NativeExecutionException error)
        {
            if (command == "execute")
            {
                WriteProtocolError(executionId, error.Code, error.Message, error.Retryable);
            }
            else
            {
                WriteJson(new StatusResponse { Status = "error", Reason = $"helper_failure:{error.Code}" });
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            if (command == "execute")
            {
                WriteProtocolError(executionId, "protocol_failure", "native sandbox helper failed", false);
                return 0;
            }
            WriteJson(new StatusResponse { Status = "error", Reason = "helper_failure:internal_error" });
            return 1;
        }
    }

    private static string ParseStateRoot(IReadOnlyList<string> args)
    {
        if (args.Count != 3 || args[1] != "--state-root")
        {
            throw new RequestException("expected <command> --state-root <absolute-path>");
        }
        return PathPolicy.NormalizeAbsolute(args[2], "--state-root");
    }

    internal static T Deserialize<T>(string input) where T : class
    {
        var value = JsonSerializer.Deserialize<T>(input, JsonProtocol.Options);
        return value ?? throw new RequestException("request body must be a JSON object");
    }

    internal static async Task<string> ReadBoundedInputAsync()
    {
        var buffer = new char[16_384];
        var content = new System.Text.StringBuilder();
        while (true)
        {
            var read = await Console.In.ReadAsync(buffer.AsMemory());
            if (read == 0)
            {
                return content.ToString();
            }
            if (content.Length + read > MaxInputCharacters)
            {
                throw new RequestException("request body exceeds the protocol limit");
            }
            content.Append(buffer, 0, read);
        }
    }

    private static void WriteUnsupported(string? command)
    {
        if (command == "execute")
        {
            WriteProtocolError(null, "unsupported_platform", "Windows native sandbox requires Windows", false);
            return;
        }
        WriteJson(new StatusResponse
        {
            Status = "unsupported",
            Reason = "windows_native_sandbox_requires_windows",
        });
    }

    private static void WriteProtocolError(string? executionId, string code, string message, bool retryable)
    {
        NativeProtocolWriter.Console.Error(executionId, code, message, retryable);
    }

    private static void WriteJson<T>(T value) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(value, JsonProtocol.Options));

    internal static string HashAccountSid(string sid) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid))).ToLowerInvariant();
}
