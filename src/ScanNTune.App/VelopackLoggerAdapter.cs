using System;
using Microsoft.Extensions.Logging;
using Velopack.Logging;

namespace ScanNTune.App;

/// <summary>
/// Bridges Velopack's own <see cref="IVelopackLogger"/> onto the app's Serilog-backed
/// <see cref="ILogger"/>, so update-engine diagnostics land in the same log file as everything else.
/// The two level enums line up one-to-one.
/// </summary>
public sealed class VelopackLoggerAdapter : IVelopackLogger
{
    private readonly ILogger _logger;

    public VelopackLoggerAdapter(ILogger logger) => _logger = logger;

    public void Log(VelopackLogLevel logLevel, string? message, Exception? exception)
        => _logger.Log(ToMicrosoft(logLevel), exception, "{VelopackMessage}", message);

    private LogLevel ToMicrosoft(VelopackLogLevel level) => level switch
    {
        VelopackLogLevel.Trace => LogLevel.Trace,
        VelopackLogLevel.Debug => LogLevel.Debug,
        VelopackLogLevel.Information => LogLevel.Information,
        VelopackLogLevel.Warning => LogLevel.Warning,
        VelopackLogLevel.Error => LogLevel.Error,
        VelopackLogLevel.Critical => LogLevel.Critical,
        _ => LogLevel.Information,
    };
}
