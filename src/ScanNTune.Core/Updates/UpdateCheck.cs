using Microsoft.Extensions.Logging;

namespace ScanNTune.Core.Updates;

/// <summary>
/// Runs the background update flow once at startup: check → download → stage for next restart. The updater
/// is built through a factory so a construction fault is caught by the same try as the rest. Every step and
/// every failure is logged (the logger is required, never null), and any exception is swallowed so
/// a flaky network or offline machine never blocks the app from opening. All awaits use
/// <c>ConfigureAwait(false)</c> so the download continuations stay off the UI thread.
/// </summary>
public sealed class UpdateCheck
{
    private readonly Func<IAppUpdater> _updaterFactory;
    private readonly ILogger<UpdateCheck> _logger;

    public UpdateCheck(Func<IAppUpdater> updaterFactory, ILogger<UpdateCheck> logger)
    {
        _updaterFactory = updaterFactory;
        _logger = logger;
    }

    public async Task<UpdateOutcome> RunAsync()
    {
        try
        {
            var updater = _updaterFactory();

            _logger.LogInformation("Checking for updates…");
            if (!await updater.CheckForUpdateAsync().ConfigureAwait(false))
            {
                _logger.LogInformation("No update available.");
                return UpdateOutcome.UpToDate;
            }

            _logger.LogInformation("Update found; downloading…");
            await updater.DownloadUpdateAsync().ConfigureAwait(false);

            updater.ApplyUpdateOnExit();
            _logger.LogInformation("Update downloaded and staged; it applies on the next restart.");
            return UpdateOutcome.UpdateStaged;
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Background update check failed.");
            return UpdateOutcome.Failed;
        }
    }
}
