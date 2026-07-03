using System;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using Avalonia.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Extensions.Logging;
using ScanNTune.Core;
using ScanNTune.Core.Calibration;
using ScanNTune.Core.Combining;
using ScanNTune.Core.Output;

namespace ScanNTune.App.ViewModels;

/// <summary>
/// The two-scan input page: the user loads two scans of the same coupon — the second taken after a
/// quarter-turn — sets the DPI/coupon geometry, and analyzes. Both scans are required: a single scan
/// cannot separate the printer's error from the scanner's, so there is deliberately no one-scan path.
/// </summary>
public partial class ScanPageViewModel : ViewModelBase
{
    private readonly ICouponAnalyzer _analyzer;
    private readonly IScanCombiner _combiner;
    private readonly IOverlayRenderer _overlayRenderer;
    private readonly ICalibrationStore _calibrationStore;
    private readonly Action<TwoScanResult, CouponSpec, Bitmap?, Bitmap?> _onAnalyzed;
    private readonly Action _onCalibrate;
    private readonly ScannerCalibration? _calibration;
    private readonly ILogger<ScanPageViewModel> _logger;

    [ObservableProperty]
    private string? _scan1Path;

    [ObservableProperty]
    private string? _scan2Path;

    [ObservableProperty]
    private Bitmap? _scan1Thumb;

    [ObservableProperty]
    private Bitmap? _scan2Thumb;

    [ObservableProperty]
    private string _dpiText = "1200";

    [ObservableProperty]
    private string _baselineMmText = "100";

    [ObservableProperty]
    private string _gridText = "5";

    [ObservableProperty]
    private bool _isBusy;

    [ObservableProperty]
    private bool _isError;

    [ObservableProperty]
    private bool _scan1Failed;

    [ObservableProperty]
    private bool _scan2Failed;

    [ObservableProperty]
    private string _scan1Note = string.Empty;

    [ObservableProperty]
    private string _scan2Note = string.Empty;

    [ObservableProperty]
    private string _statusText = string.Empty;

    public ScanPageViewModel(
        ICouponAnalyzer analyzer,
        IScanCombiner combiner,
        IOverlayRenderer overlayRenderer,
        ICalibrationStore calibrationStore,
        Action<TwoScanResult, CouponSpec, Bitmap?, Bitmap?> onAnalyzed,
        Action onCalibrate,
        ILogger<ScanPageViewModel> logger)
    {
        _analyzer = analyzer;
        _combiner = combiner;
        _overlayRenderer = overlayRenderer;
        _calibrationStore = calibrationStore;
        _onAnalyzed = onAnalyzed;
        _onCalibrate = onCalibrate;
        _logger = logger;
        _calibration = calibrationStore.Load();
    }

    public bool IsCalibrated => _calibration is not null;

    // Single status line under the step-1 header (the header already says "Calibrate scanner").
    public string CalibrationLineText => _calibration is null
        ? "Optional — calibrate once for absolute X/Y scale. Skew and anisotropy work without it."
        : $"Calibrated · {_calibration.EffectiveDpi.ToString("0", CultureInfo.InvariantCulture)} dpi — absolute scale anchored to your scanner.";

    public string CalibrateButtonText => _calibration is null ? "Calibrate scanner" : "Recalibrate";

    [RelayCommand]
    private void Calibrate() => _onCalibrate();

    public bool HasScan1 => Scan1Thumb is not null;

    public bool HasScan2 => Scan2Thumb is not null;

    public bool HasStatus => !string.IsNullOrEmpty(StatusText);

    public string Scan1Caption => Caption(Scan1Path, Scan1Thumb);

    public string Scan2Caption => Caption(Scan2Path, Scan2Thumb);

    private string Caption(string? path, Bitmap? bitmap) =>
        path is null || bitmap is null
            ? string.Empty
            : $"{Path.GetFileName(path)} · {bitmap.PixelSize.Width}×{bitmap.PixelSize.Height}";

    /// <summary>Load the first (0°) scan; a bad file is surfaced to the status line, not thrown.</summary>
    public void LoadScan1(string path) => Load(path, isFirst: true);

    /// <summary>Load the second (quarter-turned) scan.</summary>
    public void LoadScan2(string path) => Load(path, isFirst: false);

    private void Load(string path, bool isFirst)
    {
        try
        {
            IsError = false;
            var bitmap = new Bitmap(path);
            if (isFirst)
            {
                Scan1Thumb?.Dispose();
                Scan1Thumb = bitmap;
                Scan1Path = path;
                Scan1Failed = false;
                Scan1Note = string.Empty;
                OnPropertyChanged(nameof(HasScan1));
                OnPropertyChanged(nameof(Scan1Caption));
            }
            else
            {
                Scan2Thumb?.Dispose();
                Scan2Thumb = bitmap;
                Scan2Path = path;
                Scan2Failed = false;
                Scan2Note = string.Empty;
                OnPropertyChanged(nameof(HasScan2));
                OnPropertyChanged(nameof(Scan2Caption));
            }
            // The filename is shown in the slot itself, so the status line stays quiet on load —
            // it's reserved for transient states (analyzing, errors).
            StatusText = string.Empty;
            AnalyzeCommand.NotifyCanExecuteChanged();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not load scan image {Path}.", path);
            IsError = true;
            StatusText = $"Could not load image: {ex.Message}";
        }
    }

    [RelayCommand(CanExecute = nameof(CanAnalyze))]
    private async Task AnalyzeAsync()
    {
        if (Scan1Path is not { } path1 || Scan2Path is not { } path2)
            return;

        IsBusy = true;
        IsError = false;
        Scan1Failed = false;
        Scan2Failed = false;
        Scan1Note = string.Empty;
        Scan2Note = string.Empty;
        AnalyzeCommand.NotifyCanExecuteChanged();
        StatusText = "Analyzing both scans…";
        try
        {
            // With a stored calibration, use the scanner's measured px/mm directly (the coupon is
            // scanned at the calibrated DPI); otherwise fall back to the entered nominal DPI/25.4
            // (anisotropy + skew stay correct either way).
            double? pxPerMm;
            if (_calibration is not null)
                pxPerMm = _calibration.PxPerMm;
            else
                pxPerMm = double.TryParse(DpiText, NumberStyles.Float, CultureInfo.InvariantCulture, out double dpi) && dpi > 0
                    ? dpi / 25.4
                    : null;
            CouponSpec coupon = BuildCoupon();
            var options = new AnalysisOptions { PxPerMm = pxPerMm, Coupon = coupon };

            (TwoScanResult result, byte[] overlayA, byte[] overlayB) = await Task.Run(() =>
            {
                CalibrationResult a = AnalyzeScan(path1, options, isFirst: true);
                CalibrationResult b = AnalyzeScan(path2, options, isFirst: false);
                TwoScanResult combined = _combiner.Combine(a, b);
                return (combined, _overlayRenderer.RenderPng(path1, a), _overlayRenderer.RenderPng(path2, b));
            });

            StatusText = string.Empty;
            _onAnalyzed(result, coupon, ToBitmap(overlayA), ToBitmap(overlayB));
        }
        catch (ScanAnalysisException ex)
        {
            _logger.LogWarning("Scan analysis could not align {Which} scan ({Rings} rings): {Message}",
                ex.IsFirst ? "first" : "second", ex.RingCount, ex.Message);
            // Show what the failing scan DID capture, in its own slot, alongside the guidance.
            ShowScanFailure(ex);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Two-scan analysis failed.");
            IsError = true;
            StatusText = $"{ex.Message} — check the scan quality and that the coupon's two-solid marker is visible.";
        }
        finally
        {
            IsBusy = false;
            AnalyzeCommand.NotifyCanExecuteChanged();
        }
    }

    /// <summary>
    /// Analyze one scan. On a resolve failure, render the rings that WERE found and rethrow a
    /// <see cref="ScanAnalysisException"/> carrying that diagnostic so the UI can show it.
    /// </summary>
    private CalibrationResult AnalyzeScan(string path, AnalysisOptions options, bool isFirst)
    {
        try
        {
            return _analyzer.Analyze(path, options);
        }
        catch (CouponAnalysisException ex)
        {
            byte[] diagnostic = _overlayRenderer.RenderDetectionPng(path, ex.DetectedRings);
            throw new ScanAnalysisException(isFirst, ex.DetectedRings.Count, ex.Message, diagnostic);
        }
    }

    private void ShowScanFailure(ScanAnalysisException ex)
    {
        IsError = true;
        string which = ex.IsFirst ? "First scan" : "Second scan";
        string note = ex.RingCount > 0
            ? $"⚠ {ex.RingCount} rings found, but couldn't align them"
            : "⚠ nothing detected";
        Bitmap diagnostic = ToBitmap(ex.DiagnosticPng);

        if (ex.IsFirst)
        {
            Scan1Thumb?.Dispose();
            Scan1Thumb = diagnostic;
            Scan1Failed = true;
            Scan1Note = note;
            OnPropertyChanged(nameof(HasScan1));
        }
        else
        {
            Scan2Thumb?.Dispose();
            Scan2Thumb = diagnostic;
            Scan2Failed = true;
            Scan2Note = note;
            OnPropertyChanged(nameof(HasScan2));
        }

        StatusText = ex.RingCount > 0
            ? $"{which}: found {ex.RingCount} rings but couldn't locate the orientation marker. " +
              "Check that both solid marker rings and the whole coupon are in the scan (green circles show what was detected)."
            : $"{which}: no rings detected. The coupon may be out of frame or too faint — check the scan contrast and DPI.";
    }

    private bool CanAnalyze() => !IsBusy && Scan1Path is not null && Scan2Path is not null;

    partial void OnStatusTextChanged(string value) => OnPropertyChanged(nameof(HasStatus));

    private CouponSpec BuildCoupon()
    {
        var coupon = new CouponSpec();
        if (double.TryParse(BaselineMmText, NumberStyles.Float, CultureInfo.InvariantCulture, out double baseline) && baseline > 0)
            coupon = coupon with { BaselineMm = baseline };
        if (int.TryParse(GridText, NumberStyles.Integer, CultureInfo.InvariantCulture, out int grid) && grid >= 2)
            coupon = coupon with { GridN = grid };
        return coupon;
    }

    private Bitmap ToBitmap(byte[] png)
    {
        using var stream = new MemoryStream(png);
        return new Bitmap(stream);
    }
}
