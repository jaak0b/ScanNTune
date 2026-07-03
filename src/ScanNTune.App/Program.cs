using Avalonia;
using System;
using System.IO;
using Serilog;
using Serilog.Extensions.Logging;
using Velopack;

namespace ScanNTune.App;

sealed class Program
{
    // Initialization code. Don't use any Avalonia, third-party APIs or any
    // SynchronizationContext-reliant code before AppMain is called: things aren't initialized
    // yet and stuff might break.
    [STAThread]
    public static void Main(string[] args)
    {
        string logDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ScanNTune", "logs");
        Directory.CreateDirectory(logDir);

        // Serilog is the single logging backend for the whole app: rolling daily file plus the debug
        // output. App.axaml.cs bridges it to ILogger<T> and wires the global exception handlers.
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Debug()
            .Enrich.FromLogContext()
            .WriteTo.Debug()
            .WriteTo.File(
                Path.Combine(logDir, "scanntune-.log"),
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 7,
                outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}")
            .CreateLogger();

        try
        {
            Log.Information("ScanNTune starting.");

            // Must run first: handles Velopack's install/update/uninstall hooks (may exit the process).
            VelopackApp.Build()
                .SetLogger(new VelopackLoggerAdapter(new SerilogLoggerFactory(Log.Logger).CreateLogger("Velopack")))
                .Run();

            BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
        }
        catch (Exception ex)
        {
            Log.Fatal(ex, "ScanNTune terminated unexpectedly.");
        }
        finally
        {
            Log.CloseAndFlush();
        }
    }

    // Avalonia configuration, don't remove; also used by visual designer.
    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
#if DEBUG
            .WithDeveloperTools()
#endif
            .WithInterFont()
            .LogToTrace();
}
