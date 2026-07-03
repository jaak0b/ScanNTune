using OpenCvSharp;

namespace ScanNTune.Tests;

/// <summary>
/// Image transforms shared by the orientation tests. They warp the geometrically-perfect coupon
/// render to fake a print imperfection (anisotropic <see cref="StretchX"/> / skew <see cref="Shear"/>),
/// then place it on the "scanner" (mirror-<see cref="FlipY"/> + 90° <see cref="Rotate"/>). Each returns
/// a fresh <see cref="Mat"/> the caller owns (wrap in <c>using</c>).
/// </summary>
public sealed class CouponImageTransforms
{
    /// <summary>Anisotropic scale on X only (physical X ≠ Y), e.g. factor 1.02 = +2%.</summary>
    public Mat StretchX(Mat src, double factor)
    {
        var dst = new Mat();
        Cv2.Resize(src, dst, new Size((int)Math.Round(src.Width * factor), src.Height));
        return dst;
    }

    /// <summary>Horizontal shear by the given angle (degrees) — fakes XY skew.</summary>
    public Mat Shear(Mat src, double degrees)
    {
        double k = Math.Tan(degrees * Math.PI / 180.0);
        int extra = (int)Math.Ceiling(Math.Abs(k) * src.Height) + 4;
        using var transform = new Mat(2, 3, MatType.CV_64FC1);
        transform.Set(0, 0, 1.0); transform.Set(0, 1, k); transform.Set(0, 2, 0.0);
        transform.Set(1, 0, 0.0); transform.Set(1, 1, 1.0); transform.Set(1, 2, 0.0);
        var dst = new Mat();
        Cv2.WarpAffine(src, dst, transform, new Size(src.Width + extra, src.Height),
            InterpolationFlags.Cubic, BorderTypes.Constant, Scalar.Black);
        return dst;
    }

    /// <summary>Mirror-flip about the vertical axis (as if the coupon was scanned face-down).</summary>
    public Mat FlipY(Mat src)
    {
        var dst = new Mat();
        Cv2.Flip(src, dst, FlipMode.Y);
        return dst;
    }

    /// <summary>Rotate 0/90/180/270° clockwise (how the coupon happened to sit on the glass).</summary>
    public Mat Rotate(Mat src, int degrees)
    {
        var dst = new Mat();
        switch (degrees)
        {
            case 90: Cv2.Rotate(src, dst, RotateFlags.Rotate90Clockwise); break;
            case 180: Cv2.Rotate(src, dst, RotateFlags.Rotate180); break;
            case 270: Cv2.Rotate(src, dst, RotateFlags.Rotate90Counterclockwise); break;
            default: src.CopyTo(dst); break;
        }
        return dst;
    }
}
