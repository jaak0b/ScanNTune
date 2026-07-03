using System;
using System.Reflection;
using Avalonia.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Extensions.Logging;
using ScanNTune.Core;
using ScanNTune.Core.Calibration;
using ScanNTune.Core.Combining;
using ScanNTune.Core.Output;

namespace ScanNTune.App.ViewModels;

/// <summary>
/// The application shell. It owns the engine services and the in-window navigation: a single
/// <see cref="CurrentPage"/> is swapped between the scan-input page and the results page (resolved
/// to a view by the <c>ViewLocator</c>). Keeping navigation to one hosted page — rather than
/// separate windows or dialogs — is what makes a later Avalonia/WebAssembly port a UI-hosting swap.
/// </summary>
public partial class MainWindowViewModel : ViewModelBase
{
    private readonly ICouponAnalyzer _analyzer;
    private readonly IScanCombiner _combiner;
    private readonly IOverlayRenderer _overlayRenderer;
    private readonly ICorrectionFormatter _corrections;
    private readonly IScaleReferenceMeasurer _measurer;
    private readonly ICalibrationStore _calibrationStore;
    private readonly ILoggerFactory _loggerFactory;

    [ObservableProperty]
    private ViewModelBase _currentPage = null!;

    /// <summary>Set once a background update has been downloaded and staged for the next restart.</summary>
    [ObservableProperty]
    private bool _updateReady;

    public string UpdateStatusText => "Update ready — restart to apply";

    /// <summary>Display version for the title bar, e.g. "v0.1.24" — stamped by Nerdbank.GitVersioning.</summary>
    public string AppVersion
    {
        get
        {
            Assembly assembly = typeof(MainWindowViewModel).Assembly;
            string? informational = assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            string version = informational?.Split('+', 2)[0]
                ?? assembly.GetName().Version?.ToString(3)
                ?? "0.0.0";
            return $"v{version}";
        }
    }

    // Design-time fallback: Serilog's Log.Logger is a silent logger until Program.Main configures it.
    public MainWindowViewModel()
        : this(new SerilogLoggerFactory(Log.Logger))
    {
    }

    public MainWindowViewModel(ILoggerFactory loggerFactory)
        : this(new CouponAnalyzer(), new ScannerCancellingCombiner(), new OverlayRenderer(), new CorrectionFormatter(),
               new CardEdgeMeasurer(), new JsonCalibrationStore(), loggerFactory)
    {
    }

    public MainWindowViewModel(
        ICouponAnalyzer analyzer,
        IScanCombiner combiner,
        IOverlayRenderer overlayRenderer,
        ICorrectionFormatter corrections,
        IScaleReferenceMeasurer measurer,
        ICalibrationStore calibrationStore,
        ILoggerFactory loggerFactory)
    {
        _analyzer = analyzer;
        _combiner = combiner;
        _overlayRenderer = overlayRenderer;
        _corrections = corrections;
        _measurer = measurer;
        _calibrationStore = calibrationStore;
        _loggerFactory = loggerFactory;
        CurrentPage = CreateScanPage();
    }

    public void MarkUpdateReady() => UpdateReady = true;

    private ScanPageViewModel CreateScanPage() =>
        new(_analyzer, _combiner, _overlayRenderer, _calibrationStore, ShowResults, ShowCalibration,
            _loggerFactory.CreateLogger<ScanPageViewModel>());

    private void ShowResults(TwoScanResult result, CouponSpec coupon, Bitmap? overlayA, Bitmap? overlayB) =>
        CurrentPage = new ResultsPageViewModel(result, coupon, overlayA, overlayB, _corrections, StartOver);

    private void ShowCalibration() =>
        CurrentPage = new CalibrationPageViewModel(_measurer, _calibrationStore, StartOver,
            _loggerFactory.CreateLogger<CalibrationPageViewModel>());

    // Rebuilding the scan page re-reads the stored calibration, so the status pill reflects a
    // just-saved calibration on return.
    private void StartOver() => CurrentPage = CreateScanPage();
}
