using System;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Extensions.Logging;
using ScanNTune.App.ViewModels;
using ScanNTune.App.Views;
using ScanNTune.Core.Updates;

namespace ScanNTune.App;

public partial class App : Application
{
    // Bridge Serilog (configured in Program.Main) to ILogger<T> for the whole UI layer. At design time
    // Serilog's Log.Logger is a silent logger, so this is a no-op there.
    private readonly ILoggerFactory _loggerFactory = new SerilogLoggerFactory(Log.Logger);

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        ILogger<App> log = _loggerFactory.CreateLogger<App>();

        // Catch everything the try/catch in Program.Main can't: exceptions on other threads and faults in
        // un-awaited tasks. Without these, a background crash would vanish with no trace.
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            log.LogCritical(e.ExceptionObject as Exception, "Unhandled AppDomain exception.");
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            log.LogError(e.Exception, "Unobserved task exception.");
            e.SetObserved();
        };

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var mainViewModel = new MainWindowViewModel(_loggerFactory);
            desktop.MainWindow = new MainWindow { DataContext = mainViewModel };

            StartBackgroundUpdateCheck(mainViewModel);
        }

        base.OnFrameworkInitializationCompleted();
    }

    // Best-effort, off the UI thread: check for an update and, if one is found, stage it to apply on the next
    // launch (never mid-session), then surface a "restart to update" cue. No-ops in dev / non-installed runs.
    private void StartBackgroundUpdateCheck(MainWindowViewModel mainViewModel)
    {
        ILogger<VelopackAppUpdater> updaterLog = _loggerFactory.CreateLogger<VelopackAppUpdater>();
        ILogger<UpdateCheck> checkLog = _loggerFactory.CreateLogger<UpdateCheck>();

        _ = Task.Run(async () =>
        {
            UpdateOutcome outcome = await new UpdateCheck(() => new VelopackAppUpdater(updaterLog), checkLog).RunAsync();
            if (outcome == UpdateOutcome.UpdateStaged)
                Dispatcher.UIThread.Post(mainViewModel.MarkUpdateReady);
        });
    }
}
