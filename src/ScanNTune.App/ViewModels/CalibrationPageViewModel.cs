using System;
using System.Globalization;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Extensions.Logging;
using ScanNTune.Core.Calibration;

namespace ScanNTune.App.ViewModels;

/// <summary>
/// The one-time scanner-calibration page. The user enters the reference card's measured long side and
/// the scan DPI, loads a scan of it, and the engine auto-detects the card edges to recover the true
/// px/mm. Quality checks (edge straightness, parallelism, and detected-size vs entered-size) surface
/// a bad scan or a mistyped value before it is saved. Saving persists the calibration and returns.
/// </summary>
public partial class CalibrationPageViewModel : ViewModelBase
{
    private const double IsoLongMm = 85.60;
    private const double IsoToleranceMm = 0.25;
    private const double MaxSizeMismatchMm = 0.3;

    private readonly IScaleReferenceMeasurer _measurer;
    private readonly ICalibrationStore _store;
    private readonly Action _onDone;
    private readonly ILogger<CalibrationPageViewModel> _logger;
    private ScaleReferenceResult? _result;
    private bool _initialized;

    [ObservableProperty]
    private string _measuredMmText = string.Empty;

    [ObservableProperty]
    private string _dpiText = "600";

    [ObservableProperty]
    private bool _isDetecting;

    [ObservableProperty]
    private bool _isError;

    [ObservableProperty]
    private string _statusText = string.Empty;

    [ObservableProperty]
    private bool _hasResult;

    [ObservableProperty]
    private string _pxPerMmText = string.Empty;

    [ObservableProperty]
    private string _effectiveDpiText = string.Empty;

    [ObservableProperty]
    private string _percentText = string.Empty;

    [ObservableProperty]
    private string _edgeQualityText = string.Empty;

    [ObservableProperty]
    private string _sizeSentence = string.Empty;

    [ObservableProperty]
    private bool _sizeCheckOk;

    [ObservableProperty]
    private bool _saved;

    public CalibrationPageViewModel(IScaleReferenceMeasurer measurer, ICalibrationStore store, Action onDone,
        ILogger<CalibrationPageViewModel> logger)
    {
        _measurer = measurer;
        _store = store;
        _onDone = onDone;
        _logger = logger;

        // Open "Recalibrate" on the current calibration — pre-fill the card's size and DPI and show
        // its detected result — instead of a blank form.
        ScannerCalibration? existing = store.Load();
        if (existing is not null)
        {
            _result = new ScaleReferenceResult(
                Success: true,
                PxPerMm: existing.PxPerMm,
                MeasuredWidthPx: existing.MeasuredWidthPx,
                DetectedMm: existing.Dpi > 0 ? existing.MeasuredWidthPx / (existing.Dpi / 25.4) : 0,
                StraightnessPx: existing.StraightnessPx,
                ParallelismDegrees: existing.ParallelismDegrees,
                EdgePointCount: 0);
            MeasuredMmText = existing.ReferenceMm.ToString("0.##", CultureInfo.InvariantCulture);
            DpiText = existing.Dpi.ToString("0", CultureInfo.InvariantCulture);
            Recompute();
            Saved = true;
        }
        _initialized = true;
    }

    public bool HasStatus => !string.IsNullOrEmpty(StatusText);

    public bool CanUpload => TryInputs(out _, out _);

    public bool IsoSanityWarn =>
        double.TryParse(MeasuredMmText, NumberStyles.Float, CultureInfo.InvariantCulture, out double v)
        && v > 0 && Math.Abs(v - IsoLongMm) > IsoToleranceMm;

    public string IsoSanityText
    {
        get
        {
            if (!double.TryParse(MeasuredMmText, NumberStyles.Float, CultureInfo.InvariantCulture, out double v) || v <= 0)
                return "Enter your calipered value.";
            double d = v - IsoLongMm;
            if (Math.Abs(d) <= IsoToleranceMm)
                return "In range for an ISO card (≈85.60 mm).";
            return $"{d.ToString("+0.00;-0.00", CultureInfo.InvariantCulture)} mm vs ISO 85.60 — re-check the caliper.";
        }
    }

    /// <summary>Loads the reference scan and auto-detects the card off the UI thread.</summary>
    public async Task LoadScanAsync(string path)
    {
        if (!TryInputs(out double mm, out double dpi))
        {
            IsError = true;
            StatusText = "Enter your measured size and DPI first.";
            return;
        }

        IsDetecting = true;
        IsError = false;
        HasResult = false;
        StatusText = "Detecting the card…";
        try
        {
            ScaleReferenceResult res = await Task.Run(() => _measurer.Measure(path, mm, dpi));
            if (!res.Success)
            {
                _result = null;
                IsError = true;
                StatusText = res.Message ?? "Couldn't detect the card in that scan.";
                return;
            }
            _result = res;
            StatusText = string.Empty;
            Recompute(); // sets HasResult (inputs are valid at this point)
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Couldn't read the card scan {Path}.", path);
            _result = null;
            IsError = true;
            StatusText = $"Couldn't read the scan: {ex.Message}";
        }
        finally
        {
            IsDetecting = false;
        }
    }

    /// <summary>
    /// Re-derives the displayed figures from the (fixed) detected edge width and the current mm/DPI,
    /// so editing either field after a detection updates the result without re-scanning.
    /// </summary>
    private void Recompute()
    {
        if (_result is null)
            return;
        if (!TryInputs(out double mm, out double dpi))
        {
            // Inputs went incomplete after a detection — hide the now-stale result (and Save) until
            // a valid mm/DPI is entered again.
            HasResult = false;
            return;
        }

        double widthPx = _result.MeasuredWidthPx;
        double pxPerMm = widthPx / mm;
        double detectedMm = widthPx / (dpi / 25.4);
        double sizeDiff = Math.Abs(detectedMm - mm);

        PxPerMmText = pxPerMm.ToString("0.000", CultureInfo.InvariantCulture);
        EffectiveDpiText = (pxPerMm * 25.4).ToString("0", CultureInfo.InvariantCulture);
        PercentText = ((pxPerMm / (dpi / 25.4) - 1.0) * 100.0).ToString("+0.000;-0.000", CultureInfo.InvariantCulture) + "%";
        EdgeQualityText = $"Edges straight to {_result.StraightnessPx.ToString("0.00", CultureInfo.InvariantCulture)} px, " +
                          $"parallel to {_result.ParallelismDegrees.ToString("0.000", CultureInfo.InvariantCulture)}°.";
        SizeCheckOk = sizeDiff < MaxSizeMismatchMm;
        string detected = detectedMm.ToString("0.00", CultureInfo.InvariantCulture);
        string entered = mm.ToString("0.00", CultureInfo.InvariantCulture);
        SizeSentence = SizeCheckOk
            ? $"Detected {detected} mm — matches your {entered} mm."
            : $"Detected {detected} mm doesn't match your {entered} mm — re-check the DPI or your measurement.";
        HasResult = true;
        Persist();
    }

    /// <summary>
    /// Saves automatically once a scan is detected and its size checks out — there is no separate
    /// save step. A size-mismatched detection (wrong DPI or a mistyped reference) is NOT persisted,
    /// so it can't silently overwrite a good calibration.
    /// </summary>
    private void Persist()
    {
        if (!_initialized || _result is null || !TryInputs(out double mm, out double dpi) || !SizeCheckOk)
        {
            Saved = false;
            return;
        }

        var calibration = new ScannerCalibration(
            PxPerMm: _result.MeasuredWidthPx / mm,
            Dpi: dpi,
            ReferenceMm: mm,
            MeasuredWidthPx: _result.MeasuredWidthPx,
            StraightnessPx: _result.StraightnessPx,
            ParallelismDegrees: _result.ParallelismDegrees,
            CalibratedUtc: DateTime.UtcNow);
        try
        {
            _store.Save(calibration);
            Saved = true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Couldn't save the scanner calibration.");
            Saved = false;
            IsError = true;
            StatusText = $"Couldn't save the calibration: {ex.Message}";
        }
    }

    [RelayCommand]
    private void Back() => _onDone();

    partial void OnStatusTextChanged(string value) => OnPropertyChanged(nameof(HasStatus));

    partial void OnMeasuredMmTextChanged(string value)
    {
        ClearErrorOnEdit();
        OnPropertyChanged(nameof(IsoSanityText));
        OnPropertyChanged(nameof(IsoSanityWarn));
        OnPropertyChanged(nameof(CanUpload));
        Recompute();
    }

    partial void OnDpiTextChanged(string value)
    {
        ClearErrorOnEdit();
        OnPropertyChanged(nameof(CanUpload));
        Recompute();
    }

    // A prior detection error shouldn't linger over now-valid inputs.
    private void ClearErrorOnEdit()
    {
        if (IsError)
        {
            IsError = false;
            StatusText = string.Empty;
        }
    }

    private bool TryInputs(out double mm, out double dpi)
    {
        dpi = 0;
        return double.TryParse(MeasuredMmText, NumberStyles.Float, CultureInfo.InvariantCulture, out mm) && mm > 0
            && double.TryParse(DpiText, NumberStyles.Float, CultureInfo.InvariantCulture, out dpi) && dpi > 0;
    }
}
