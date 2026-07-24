using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ariadne.WindowsSandbox;

internal static partial class FirewallManager
{
    internal const string RulePrefix = "Ariadne-Sandbox-Offline-v1";
    private const int CommandTimeoutMilliseconds = 30_000;
    private const int MaxCommandOutputCharacters = 1024 * 1024;
    private const string Script = """
        $ErrorActionPreference = 'Stop'
        $operation = $env:ARIADNE_FW_OPERATION
        $offlineSid = $env:ARIADNE_FW_SID
        $allowLoopback = $env:ARIADNE_FW_LOOPBACK
        $prefix = 'Ariadne-Sandbox-Offline-v1'
        $netSecurityModule = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1'
        Import-Module -Name $netSecurityModule -Force -ErrorAction Stop
        if ($operation -notin @('apply', 'verify')) { throw 'invalid_operation' }
        if ($offlineSid -notmatch '^S-\d+(?:-\d+)+$') { throw 'invalid_sid' }
        if ($allowLoopback -notin @('true', 'false')) { throw 'invalid_loopback' }
        $localUser = "D:(A;;CC;;;$offlineSid)"
        $allName = "$prefix-all"
        $ipv4Name = "$prefix-ipv4"
        $ipv6Name = "$prefix-ipv6"

        if ($operation -eq 'apply') {
          Get-NetFirewallRule -PolicyStore PersistentStore -Name "$prefix-*" -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction Stop
          if ($allowLoopback -eq 'true') {
            New-NetFirewallRule -PolicyStore PersistentStore -Name $ipv4Name -DisplayName 'Ariadne offline sandbox IPv4' -Direction Outbound -Action Block -Enabled True -Profile Any -LocalUser $localUser -RemoteAddress @('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255') | Out-Null
            New-NetFirewallRule -PolicyStore PersistentStore -Name $ipv6Name -DisplayName 'Ariadne offline sandbox IPv6' -Direction Outbound -Action Block -Enabled True -Profile Any -LocalUser $localUser -RemoteAddress @('::','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') | Out-Null
          } else {
            New-NetFirewallRule -PolicyStore PersistentStore -Name $allName -DisplayName 'Ariadne offline sandbox' -Direction Outbound -Action Block -Enabled True -Profile Any -LocalUser $localUser | Out-Null
          }
        }

        function Get-SingleFilter($rule, [string]$command, [string]$name) {
          $filter = @($rule | & $command -ErrorAction Stop)
          if ($filter.Count -ne 1) { throw "invalid_filter:${name}:$command" }
          return $filter[0]
        }

        function Get-RuleSnapshot([string]$name) {
          $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction Stop)
          if ($rules.Count -ne 1) { throw "invalid_rule_count:$name" }
          $rule = $rules[0]
          $address = Get-SingleFilter $rule 'Get-NetFirewallAddressFilter' $name
          $port = Get-SingleFilter $rule 'Get-NetFirewallPortFilter' $name
          $application = Get-SingleFilter $rule 'Get-NetFirewallApplicationFilter' $name
          $service = Get-SingleFilter $rule 'Get-NetFirewallServiceFilter' $name
          $interfaceType = Get-SingleFilter $rule 'Get-NetFirewallInterfaceTypeFilter' $name
          $interface = Get-SingleFilter $rule 'Get-NetFirewallInterfaceFilter' $name
          $security = Get-SingleFilter $rule 'Get-NetFirewallSecurityFilter' $name
          $negated = @()
          if ($address.IsNegated) { $negated += 'address' }
          if ($port.IsNegated) { $negated += 'port' }
          if ($application.IsNegated) { $negated += 'application' }
          if ($service.IsNegated) { $negated += 'service' }
          if ($interfaceType.IsNegated) { $negated += 'interfaceType' }
          if ($interface.IsNegated) { $negated += 'interface' }
          if ($security.IsNegated) { $negated += 'security' }
          return [ordered]@{
            name = [string]$rule.Name
            enabled = [string]$rule.Enabled
            direction = [string]$rule.Direction
            action = [string]$rule.Action
            profile = [string]$rule.Profile
            primaryStatus = [string]$rule.PrimaryStatus
            policyStoreSourceType = [string]$rule.PolicyStoreSourceType
            edgeTraversalPolicy = [string]$rule.EdgeTraversalPolicy
            looseSourceMapping = [bool]$rule.LooseSourceMapping
            localOnlyMapping = [bool]$rule.LocalOnlyMapping
            localAddresses = @($address.LocalAddress | ForEach-Object { [string]$_ })
            remoteAddresses = @($address.RemoteAddress | ForEach-Object { [string]$_ })
            protocol = [string]$port.Protocol
            localPorts = @($port.LocalPort | ForEach-Object { [string]$_ })
            remotePorts = @($port.RemotePort | ForEach-Object { [string]$_ })
            icmpType = [string]$port.IcmpType
            dynamicTarget = [string]$port.DynamicTarget
            program = [string]$application.Program
            package = [string]$application.Package
            service = [string]$service.Service
            interfaceType = [string]$interfaceType.InterfaceType
            interfaceAliases = @($interface.InterfaceAlias | ForEach-Object { [string]$_ })
            authentication = [string]$security.Authentication
            encryption = [string]$security.Encryption
            overrideBlockRules = [bool]$security.OverrideBlockRules
            localUser = [string]$security.LocalUser
            remoteUser = [string]$security.RemoteUser
            remoteMachine = [string]$security.RemoteMachine
            negatedFilters = @($negated)
          }
        }

        $expectedNames = if ($allowLoopback -eq 'true') { @($ipv4Name, $ipv6Name) } else { @($allName) }
        $firewallServiceStatus = [string](Get-Service -Name MpsSvc -ErrorAction Stop).Status
        $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object {
          [ordered]@{
            name = [string]$_.Name
            enabled = [string]$_.Enabled
            allowLocalFirewallRules = [string]$_.AllowLocalFirewallRules
            disabledInterfaceAliases = @($_.DisabledInterfaceAliases |
              ForEach-Object { [string]$_ } | Where-Object { $_.Length -gt 0 })
          }
        })
        $managedRuleNames = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name "$prefix-*" -ErrorAction SilentlyContinue |
          ForEach-Object { [string]$_.Name } | Sort-Object)
        $snapshots = @($expectedNames | ForEach-Object { Get-RuleSnapshot $_ })
        if ($allowLoopback -eq 'true') {
          if ($managedRuleNames.Count -ne 2) { throw 'invalid_managed_rule_count' }
        } elseif ($managedRuleNames.Count -ne 1) {
          throw 'invalid_managed_rule_count'
        }
        [Console]::Out.Write(([ordered]@{
          firewallServiceStatus = $firewallServiceStatus
          profiles = @($profiles)
          managedRuleNames = @($managedRuleNames)
          rules = @($snapshots)
        } | ConvertTo-Json -Depth 6 -Compress))
        """;

    internal static string Apply(string offlineSid, bool allowLoopback)
    {
        RunPowerShell("apply", offlineSid, allowLoopback);
        return RulePrefix;
    }

    internal static bool Verify(string offlineSid, bool allowLoopback)
    {
        try
        {
            RunPowerShell("verify", offlineSid, allowLoopback);
            return true;
        }
        catch (SetupException)
        {
            return false;
        }
    }

    internal static bool VerifySnapshotForTest(
        FirewallPolicySnapshot snapshot,
        string offlineSid,
        bool allowLoopback) =>
        FirewallPolicyVerifier.Verify(snapshot, RulePrefix, offlineSid, allowLoopback);

    private static void RunPowerShell(string operation, string offlineSid, bool allowLoopback)
    {
        if (!SidPattern().IsMatch(offlineSid)) throw new SetupException("firewall_sid_invalid");
        var powerShell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");
        var encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(Script));
        var startInfo = new ProcessStartInfo
        {
            FileName = powerShell,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("-NoLogo");
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-NonInteractive");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-EncodedCommand");
        startInfo.ArgumentList.Add(encodedScript);
        startInfo.Environment.Clear();
        startInfo.Environment["SYSTEMROOT"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        startInfo.Environment["WINDIR"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        startInfo.Environment["PSModulePath"] = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "Modules");
        startInfo.Environment["ARIADNE_FW_OPERATION"] = operation;
        startInfo.Environment["ARIADNE_FW_SID"] = offlineSid;
        startInfo.Environment["ARIADNE_FW_LOOPBACK"] = allowLoopback ? "true" : "false";

        var snapshot = RunPowerShellProcess(startInfo);
        if (!FirewallPolicyVerifier.Verify(snapshot, RulePrefix, offlineSid, allowLoopback))
        {
            throw new SetupException("firewall_rule_verification_failed");
        }
    }

    private static FirewallPolicySnapshot RunPowerShellProcess(ProcessStartInfo startInfo)
        => RunPowerShellProcessAsync(startInfo).GetAwaiter().GetResult();

    private static async Task<FirewallPolicySnapshot> RunPowerShellProcessAsync(ProcessStartInfo startInfo)
    {
        using var process = Process.Start(startInfo) ?? throw new SetupException("firewall_powershell_start_failed");
        var outputBudget = new CombinedOutputBudget(MaxCommandOutputCharacters);
        var stdout = ReadBoundedAsync(process.StandardOutput, outputBudget);
        var stderr = ReadBoundedAsync(process.StandardError, outputBudget);
        var streams = Task.WhenAll(stdout, stderr);
        using var timeout = new CancellationTokenSource(CommandTimeoutMilliseconds);
        var exit = process.WaitForExitAsync(timeout.Token);
        string[] output;
        try
        {
            var first = await Task.WhenAny(exit, streams);
            if (ReferenceEquals(first, streams)) output = await streams;
            await exit;
            output = await streams;
        }
        catch (OperationCanceledException error)
        {
            KillAndWait(process);
            throw new SetupException("firewall_command_timed_out", error);
        }
        catch (SetupException)
        {
            KillAndWait(process);
            throw;
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
            KillAndWait(process);
            throw new SetupException("firewall_command_output_invalid", error);
        }
        if (process.ExitCode != 0 || !string.IsNullOrWhiteSpace(output[1]))
        {
            throw new SetupException("firewall_rule_verification_failed");
        }
        try
        {
            return JsonSerializer.Deserialize<FirewallPolicySnapshot>(output[0], JsonProtocol.Options)
                ?? throw new SetupException("firewall_rule_snapshot_invalid");
        }
        catch (JsonException error)
        {
            throw new SetupException("firewall_rule_snapshot_invalid", error);
        }
    }

    private static void KillAndWait(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            return;
        }
        _ = process.WaitForExit(5_000);
    }

    private static async Task<string> ReadBoundedAsync(
        StreamReader reader,
        CombinedOutputBudget outputBudget)
    {
        var output = new StringBuilder();
        var buffer = new char[4096];
        while (true)
        {
            var count = await reader.ReadAsync(buffer);
            if (count == 0) return output.ToString();
            outputBudget.Consume(count);
            output.Append(buffer, 0, count);
        }
    }

    private sealed class CombinedOutputBudget(int maximumCharacters)
    {
        private int consumedCharacters;

        internal void Consume(int count)
        {
            if (Interlocked.Add(ref consumedCharacters, count) > maximumCharacters)
            {
                throw new SetupException("firewall_command_output_too_large");
            }
        }
    }

    [GeneratedRegex("^S-\\d+(?:-\\d+)+$", RegexOptions.CultureInvariant)]
    private static partial Regex SidPattern();
}
