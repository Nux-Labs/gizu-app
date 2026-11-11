package io.gizu.storedwallet

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.util.Locale

/**
 * Presentation-only styling for native wallet ceremonies. It owns no behavior: callers keep click
 * handling, overlay protection and window flags. Every button it creates filters obscured touches.
 *
 * Colors mirror the app's Kurage tokens in `mobile/src/theme/colors.json`; keep them in step.
 */
internal object NativeStyle {
  val ink = Color.parseColor("#04060a")
  val surface = Color.parseColor("#0a0e15")
  /** Raised card: `card` rgba(10,14,21,.86) with a `cardEdge` white 9% hairline. */
  val cardFill = Color.argb(219, 10, 14, 21)
  val cardEdge = Color.argb(23, 255, 255, 255)
  val glass = Color.argb(184, 11, 15, 22)
  val glassBorder = Color.argb(23, 255, 255, 255)
  val glassSoft = Color.argb(9, 255, 255, 255)
  val glassPressed = Color.argb(20, 255, 255, 255)
  val well = Color.argb(11, 255, 255, 255)
  val borderSoft = Color.argb(15, 255, 255, 255)
  val primaryText = Color.parseColor("#f1f4f8")
  val secondary = Color.parseColor("#9aa4b4")
  /** `fg-45`: micro text and monospace labels. */
  val faint = Color.argb(128, 255, 255, 255)
  val disabledText = Color.argb(89, 255, 255, 255)
  val neon = Color.parseColor("#7ce8f2")
  val neonFill = Color.argb(26, 124, 232, 242)
  val neonPressed = Color.parseColor("#3fa9b5")
  val neonDeep = Color.parseColor("#0e2a33")
  val cyanSoft = Color.parseColor("#bff6fb")
  val violet = Color.parseColor("#b9a6ff")
  val violetSoft = Color.parseColor("#d7ccff")
  val ctaText = Color.parseColor("#04060a")
  val danger = Color.parseColor("#fca5a5")
  val dangerBorder = Color.argb(64, 252, 165, 165)
  val dangerFill = Color.argb(15, 252, 165, 165)

  fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density).toInt()

  /** Loads the app's bundled Helvetica Neue weight, falling back to system sans. */
  fun font(context: Context, medium: Boolean): Typeface {
    val fallback =
      Typeface.create(if (medium) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
    if (Build.VERSION.SDK_INT < 26) return fallback
    return try {
      val name = if (medium) "helvetica_neue_500" else "helvetica_neue_400"
      val id = context.resources.getIdentifier(name, "font", context.packageName)
      if (id == 0) fallback else context.resources.getFont(id)
    } catch (_: Exception) {
      fallback
    }
  }

  fun rounded(context: Context, color: Int, radiusDp: Int, stroke: Int? = null): Drawable =
    GradientDrawable().apply {
      setColor(color)
      cornerRadius = dp(context, radiusDp).toFloat()
      if (stroke != null) setStroke(dp(context, 1), stroke)
    }

  /** Kurage ready-state fill: cyan-200 → violet-200 at 135°, like the app's primary button. */
  private fun primaryFill(context: Context, alpha: Int = 255): Drawable =
    GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(cyanSoft, violetSoft)).apply {
      cornerRadius = dp(context, 24).toFloat()
      this.alpha = alpha
    }

  /** Raised card, matching the app's `Surface`: 24dp corners and a hairline edge. */
  fun card(context: Context) = rounded(context, cardFill, 24, cardEdge)

  fun title(context: Context, value: String, size: Float = 24f) =
    TextView(context).apply {
      text = value
      textSize = size
      setTextColor(primaryText)
      typeface = font(context, true)
      setLineSpacing(dp(context, 2).toFloat(), 1f)
      if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
    }

  fun body(context: Context, value: String, color: Int = secondary) =
    TextView(context).apply {
      text = value
      textSize = 15f
      setTextColor(color)
      typeface = font(context, false)
      setLineSpacing(dp(context, 4).toFloat(), 1f)
    }

  /** Monospace uppercase eyebrow, like the app's `label11` typography. */
  fun label(context: Context, value: String, color: Int = faint) =
    TextView(context).apply {
      text = value.uppercase(Locale.ROOT)
      textSize = 11f
      letterSpacing = 0.055f
      setTextColor(color)
      typeface = Typeface.MONOSPACE
    }

  fun button(context: Context, label: String, primary: Boolean) =
    Button(context).apply {
      text = label
      isAllCaps = false
      textSize = 15f
      typeface = font(context, true)
      minHeight = dp(context, 56)
      minimumHeight = dp(context, 56)
      gravity = Gravity.CENTER
      setPadding(dp(context, 20), dp(context, 14), dp(context, 20), dp(context, 14))
      stateListAnimator = null
      elevation = 0f
      backgroundTintList = null
      background =
        StateListDrawable().apply {
          addState(
            intArrayOf(-android.R.attr.state_enabled),
            rounded(context, glassSoft, 24, borderSoft),
          )
          addState(
            intArrayOf(android.R.attr.state_pressed),
            if (primary) primaryFill(context, 217)
            else rounded(context, glassPressed, 24, cardEdge),
          )
          addState(
            intArrayOf(),
            if (primary) primaryFill(context) else rounded(context, well, 24, cardEdge),
          )
        }
      setTextColor(
        ColorStateList(
          arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
          intArrayOf(disabledText, if (primary) ctaText else primaryText),
        )
      )
      // Security: approval/cancel input is ignored while another window overlays this one.
      filterTouchesWhenObscured = true
    }

  fun fullWidth(context: Context, topMarginDp: Int = 0) =
    LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      )
      .apply { topMargin = dp(context, topMarginDp) }

  /**
   * Draws [root] edge to edge on the ink background and keeps its content clear of the status and
   * navigation bars, which Android 15+ otherwise draws over the top and bottom of the screen.
   */
  @Suppress("DEPRECATION")
  fun edgeToEdge(activity: Activity, root: View, paddingDp: Int) {
    val window = activity.window
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
    else
      window.decorView.systemUiVisibility =
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
          View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
          View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    val base = dp(activity, paddingDp)
    root.setOnApplyWindowInsetsListener { view, insets ->
      val left: Int
      val top: Int
      val right: Int
      val bottom: Int
      if (Build.VERSION.SDK_INT >= 30) {
        val bars =
          insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        left = bars.left
        top = bars.top
        right = bars.right
        bottom = bars.bottom
      } else {
        left = insets.systemWindowInsetLeft
        top = insets.systemWindowInsetTop
        right = insets.systemWindowInsetRight
        bottom = insets.systemWindowInsetBottom
      }
      view.setPadding(base + left, base + top, base + right, base + bottom)
      insets
    }
    root.requestApplyInsets()
  }
}
