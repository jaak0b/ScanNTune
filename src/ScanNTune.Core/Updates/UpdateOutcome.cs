namespace ScanNTune.Core.Updates;

/// <summary>Result of a background <see cref="UpdateCheck"/> run, so the UI can surface a "restart to update" cue.</summary>
public enum UpdateOutcome
{
    /// <summary>Not an installed build (dev run), or no newer version was available.</summary>
    UpToDate,

    /// <summary>A newer version was downloaded and staged; it applies on the next restart.</summary>
    UpdateStaged,

    /// <summary>The check or download failed; details were logged.</summary>
    Failed,
}
