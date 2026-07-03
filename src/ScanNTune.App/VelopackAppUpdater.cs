using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using ScanNTune.Core.Updates;
using Velopack;
using Velopack.Locators;
using Velopack.Sources;

namespace ScanNTune.App;

/// <summary>
/// Velopack-backed updater against the GitHub release feed. The staged update is applied silently after the
/// user closes the app — <c>restart: false</c> means it lands on the next launch, never interrupting a session.
/// Outside an installed build (e.g. dev runs) <see cref="UpdateManager.IsInstalled"/> is false and it no-ops.
/// The Velopack <see cref="UpdateManager"/> is given the same Serilog-backed logger as the rest of the app.
/// </summary>
public sealed class VelopackAppUpdater : IAppUpdater
{
    private readonly UpdateManager _manager;
    private readonly ILogger<VelopackAppUpdater> _logger;
    private UpdateInfo? _pending;

    public VelopackAppUpdater(ILogger<VelopackAppUpdater> logger)
    {
        _logger = logger;
        // Velopack takes its logger via the locator (its own IVelopackLogger); bridge it to our Serilog log.
        IVelopackLocator locator = VelopackLocator.CreateDefaultForPlatform(logger: new VelopackLoggerAdapter(logger));
        _manager = new UpdateManager(new GithubSource("https://github.com/jaak0b/ScanNTune", null, false), null, locator);
    }

    public async Task<bool> CheckForUpdateAsync()
    {
        if (!_manager.IsInstalled)
        {
            _logger.LogInformation("Not an installed build; skipping the update check.");
            return false;
        }

        _pending = await _manager.CheckForUpdatesAsync().ConfigureAwait(false);
        _logger.LogInformation("Update check from {Version}: {Result}.",
            _manager.CurrentVersion,
            _pending is null ? "up to date" : $"{_pending.TargetFullRelease.Version} available");
        return _pending is not null;
    }

    public async Task DownloadUpdateAsync()
    {
        if (_pending is null)
            return;

        _logger.LogInformation("Downloading update {Version}…", _pending.TargetFullRelease.Version);
        await _manager.DownloadUpdatesAsync(_pending).ConfigureAwait(false);
        _logger.LogInformation("Update {Version} downloaded.", _pending.TargetFullRelease.Version);
    }

    public void ApplyUpdateOnExit()
    {
        if (_pending is null)
            return;

        _logger.LogInformation("Staging update {Version} to apply on exit.", _pending.TargetFullRelease.Version);
        _manager.WaitExitThenApplyUpdates(_pending.TargetFullRelease, silent: true, restart: false);
    }
}
