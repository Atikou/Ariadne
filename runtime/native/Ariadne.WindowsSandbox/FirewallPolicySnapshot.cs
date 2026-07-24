using System.Security.AccessControl;

namespace Ariadne.WindowsSandbox;

internal sealed record FirewallPolicySnapshot
{
    public required string FirewallServiceStatus { get; init; }
    public required FirewallProfileSnapshot[] Profiles { get; init; }
    public required string[] ManagedRuleNames { get; init; }
    public required FirewallRuleSnapshot[] Rules { get; init; }
}

internal sealed record FirewallProfileSnapshot
{
    public required string Name { get; init; }
    public required string Enabled { get; init; }
    public required string AllowLocalFirewallRules { get; init; }
    public required string[] DisabledInterfaceAliases { get; init; }
}

internal sealed record FirewallRuleSnapshot
{
    public required string Name { get; init; }
    public required string Enabled { get; init; }
    public required string Direction { get; init; }
    public required string Action { get; init; }
    public required string Profile { get; init; }
    public required string PrimaryStatus { get; init; }
    public required string PolicyStoreSourceType { get; init; }
    public required string EdgeTraversalPolicy { get; init; }
    public required bool LooseSourceMapping { get; init; }
    public required bool LocalOnlyMapping { get; init; }
    public required string[] LocalAddresses { get; init; }
    public required string[] RemoteAddresses { get; init; }
    public required string Protocol { get; init; }
    public required string[] LocalPorts { get; init; }
    public required string[] RemotePorts { get; init; }
    public required string IcmpType { get; init; }
    public required string DynamicTarget { get; init; }
    public required string Program { get; init; }
    public required string Package { get; init; }
    public required string Service { get; init; }
    public required string InterfaceType { get; init; }
    public required string[] InterfaceAliases { get; init; }
    public required string Authentication { get; init; }
    public required string Encryption { get; init; }
    public required bool OverrideBlockRules { get; init; }
    public required string LocalUser { get; init; }
    public required string RemoteUser { get; init; }
    public required string RemoteMachine { get; init; }
    public required string[] NegatedFilters { get; init; }
}

internal static class FirewallPolicyVerifier
{
    private static readonly string[] Any = ["Any"];
    private static readonly string[] LoopbackIpv4RemoteAddresses =
    [
        "0.0.0.0-126.255.255.255",
        "128.0.0.0-255.255.255.255",
    ];
    private static readonly string[] LoopbackIpv6RemoteAddresses =
    [
        "::",
        "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ];

    internal static bool Verify(
        FirewallPolicySnapshot snapshot,
        string rulePrefix,
        string offlineSid,
        bool allowLoopback)
    {
        if (!string.Equals(snapshot.FirewallServiceStatus, "Running", StringComparison.Ordinal) ||
            !VerifyProfiles(snapshot.Profiles) ||
            snapshot.ManagedRuleNames is null ||
            snapshot.Rules is null)
        {
            return false;
        }
        var expected = allowLoopback
            ? new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                [$"{rulePrefix}-ipv4"] = LoopbackIpv4RemoteAddresses,
                [$"{rulePrefix}-ipv6"] = LoopbackIpv6RemoteAddresses,
            }
            : new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                [$"{rulePrefix}-all"] = Any,
            };
        if (!HasExactValues(snapshot.ManagedRuleNames, [.. expected.Keys]) ||
            snapshot.Rules.Length != expected.Count)
        {
            return false;
        }

        foreach (var (name, remoteAddresses) in expected)
        {
            var matches = snapshot.Rules.Where(rule =>
                    rule is not null && string.Equals(rule.Name, name, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (matches.Length != 1 || !VerifyRule(matches[0], offlineSid, remoteAddresses))
            {
                return false;
            }
        }
        return true;
    }

    private static bool VerifyProfiles(FirewallProfileSnapshot[]? profiles)
    {
        if (profiles is null || profiles.Length != 3) return false;
        var expectedNames = new[] { "Domain", "Private", "Public" };
        if (!HasExactValues(profiles.Select(profile => profile?.Name ?? "").ToArray(), expectedNames))
        {
            return false;
        }
        return profiles.All(profile =>
            profile is not null &&
            string.Equals(profile.Enabled, "True", StringComparison.Ordinal) &&
            string.Equals(profile.AllowLocalFirewallRules, "True", StringComparison.Ordinal) &&
            profile.DisabledInterfaceAliases is { Length: 0 });
    }

    private static bool VerifyRule(
        FirewallRuleSnapshot rule,
        string offlineSid,
        string[] remoteAddresses)
    {
        return string.Equals(rule.Enabled, "True", StringComparison.Ordinal) &&
               string.Equals(rule.Direction, "Outbound", StringComparison.Ordinal) &&
               string.Equals(rule.Action, "Block", StringComparison.Ordinal) &&
               string.Equals(rule.Profile, "Any", StringComparison.Ordinal) &&
               string.Equals(rule.PrimaryStatus, "OK", StringComparison.Ordinal) &&
               string.Equals(rule.PolicyStoreSourceType, "Local", StringComparison.Ordinal) &&
               string.Equals(rule.EdgeTraversalPolicy, "Block", StringComparison.Ordinal) &&
               !rule.LooseSourceMapping &&
               !rule.LocalOnlyMapping &&
               HasExactValues(rule.LocalAddresses, Any) &&
               HasExactValues(rule.RemoteAddresses, remoteAddresses) &&
               string.Equals(rule.Protocol, "Any", StringComparison.Ordinal) &&
               HasExactValues(rule.LocalPorts, Any) &&
               HasExactValues(rule.RemotePorts, Any) &&
               string.Equals(rule.IcmpType, "Any", StringComparison.Ordinal) &&
               string.Equals(rule.DynamicTarget, "Any", StringComparison.Ordinal) &&
               string.Equals(rule.Program, "Any", StringComparison.Ordinal) &&
               string.IsNullOrEmpty(rule.Package) &&
               string.Equals(rule.Service, "Any", StringComparison.Ordinal) &&
               string.Equals(rule.InterfaceType, "Any", StringComparison.Ordinal) &&
               HasExactValues(rule.InterfaceAliases, Any) &&
               string.Equals(rule.Authentication, "NotRequired", StringComparison.Ordinal) &&
               string.Equals(rule.Encryption, "NotRequired", StringComparison.Ordinal) &&
               !rule.OverrideBlockRules &&
               HasExpectedLocalUser(rule.LocalUser, offlineSid) &&
               string.Equals(rule.RemoteUser, "Any", StringComparison.Ordinal) &&
               string.Equals(rule.RemoteMachine, "Any", StringComparison.Ordinal) &&
               rule.NegatedFilters is { Length: 0 };
    }

    private static bool HasExpectedLocalUser(string actual, string offlineSid)
    {
        try
        {
            var expectedDescriptor = new RawSecurityDescriptor($"D:(A;;CC;;;{offlineSid})");
            var actualDescriptor = new RawSecurityDescriptor(actual);
            return string.Equals(
                actualDescriptor.GetSddlForm(AccessControlSections.Access),
                expectedDescriptor.GetSddlForm(AccessControlSections.Access),
                StringComparison.Ordinal);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static bool HasExactValues(string[]? actual, string[] expected)
    {
        if (actual is null || actual.Length != expected.Length) return false;
        return actual.Order(StringComparer.OrdinalIgnoreCase)
            .SequenceEqual(expected.Order(StringComparer.OrdinalIgnoreCase), StringComparer.OrdinalIgnoreCase);
    }
}
