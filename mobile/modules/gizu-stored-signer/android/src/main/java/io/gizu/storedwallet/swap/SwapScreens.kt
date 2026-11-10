package io.gizu.storedwallet.swap

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.TypefaceSpan
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import io.gizu.storedwallet.NativeStyle

/**
 * Presentation only for the native swap screens. It turns engine status and the review text into
 * readable cards but never decides, hides or rewrites anything: every line of the review text is
 * shown as given, because the passkey approval is bound to exactly that text.
 */
internal object SwapScreens {
  private val addressPattern = Regex("0x[0-9a-fA-F]{40}")
  private val addressColor = Color.parseColor("#9be3c1")
  private val warm = Color.parseColor("#f2c879")
  private val warmFill = Color.argb(22, 242, 200, 121)
  private val warmBorder = Color.argb(80, 242, 200, 121)
  private val dangerFill = Color.argb(22, 255, 155, 155)
  private val neonFill = Color.argb(30, 49, 196, 126)

  private fun dp(context: Context, value: Int) = NativeStyle.dp(context, value)

  private fun params(context: Context, top: Int = 0) =
    LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      )
      .apply { topMargin = dp(context, top) }

  /** Text with every wallet address in a monospace, tinted style so it is easy to compare. */
  private fun text(
    context: Context,
    value: String,
    size: Float = 14f,
    color: Int = NativeStyle.secondary,
    medium: Boolean = false,
  ): TextView =
    TextView(context).apply {
      val spanned = SpannableString(value)
      for (match in addressPattern.findAll(value)) {
        spanned.setSpan(
          TypefaceSpan("monospace"),
          match.range.first,
          match.range.last + 1,
          Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        spanned.setSpan(
          ForegroundColorSpan(addressColor),
          match.range.first,
          match.range.last + 1,
          Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        spanned.setSpan(
          RelativeSizeSpan(0.86f),
          match.range.first,
          match.range.last + 1,
          Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
      }
      this.text = spanned
      textSize = size
      setTextColor(color)
      typeface = NativeStyle.font(context, medium)
      setLineSpacing(dp(context, 3).toFloat(), 1f)
      // Long addresses must wrap instead of being cut off.
      setTextIsSelectable(false)
    }

  private fun card(
    context: Context,
    fill: Int = NativeStyle.glass,
    border: Int = NativeStyle.glassBorder,
  ) =
    LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      background = NativeStyle.rounded(context, fill, 20, border)
      setPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14))
    }

  private fun chip(context: Context, label: String, color: Int, fill: Int, border: Int? = null) =
    TextView(context).apply {
      text = label
      textSize = 11f
      letterSpacing = 0.08f
      setTextColor(color)
      typeface = NativeStyle.font(context, true)
      background = NativeStyle.rounded(context, fill, 12, border)
      setPadding(dp(context, 10), dp(context, 5), dp(context, 10), dp(context, 5))
    }

  private fun number(view: Map<String, Any?>, key: String, fallback: Int = 0) =
    (view[key] as? Number)?.toInt() ?: fallback

  // ── Preparing / unlock ─────────────────────────────────────────────────────────────────

  fun preparing(context: Context, title: String, message: String): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      addView(spinner(context), LinearLayout.LayoutParams(dp(context, 44), dp(context, 44)))
      addView(
        NativeStyle.title(context, title, 22f).apply { gravity = Gravity.CENTER },
        params(context, 20),
      )
      addView(
        NativeStyle.body(context, message).apply { gravity = Gravity.CENTER },
        params(context, 10),
      )
    }

  private fun spinner(context: Context) =
    ProgressBar(context).apply {
      isIndeterminate = true
      indeterminateTintList = ColorStateList.valueOf(NativeStyle.neon)
    }

  fun unlock(context: Context): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      addView(chip(context, "AUTHORIZATION ENDED", warm, warmFill, warmBorder))
      addView(NativeStyle.title(context, "Unlock to continue", 24f), params(context, 16))
      val body = card(context)
      body.addView(
        text(
          context,
          "The 15-minute authorization ended. Unlock the same plan to continue. Nothing new is approved and the plan does not change.",
          15f,
        )
      )
      addView(body, params(context, 16))
    }

  // ── Progress ───────────────────────────────────────────────────────────────────────────

  private data class Stage(val title: String, val done: Boolean, val current: Boolean)

  /** Which of the flow's human stages the engine's phase belongs to. */
  private fun stages(view: Map<String, Any?>): List<Stage> {
    val symbol = (view["targetSymbol"] as? String).orEmpty().ifBlank { "token" }
    val phase = view["phase"] as? String ?: ""
    val sell = view["direction"] == "sell"
    val names: List<String>
    val index: Int
    when {
      sell -> {
        names = listOf("Check holdings", "Sell $symbol", "Private credit", "Pay out USDC", "Done")
        index =
          when (phase) {
            "PLANNING",
            "REVIEW" -> 0
            "FUSION" -> 1
            "FUNDING",
            "CREDITED" -> 2
            "PAYOUTS" -> 3
            "COMPLETE" -> 4
            else -> 1
          }
      }
      else -> {
        names =
          listOf(
            "Check wallet and quotes",
            "Move USDC to the private balance",
            "Send to your new wallets",
            "Buy $symbol",
            "Done",
          )
        index =
          when (phase) {
            "PLANNING",
            "REVIEW" -> 0
            "FUNDING",
            "CREDITED" -> 1
            "PAYOUTS" -> 2
            "FUSION" -> 3
            "COMPLETE" -> 4
            else -> 0
          }
      }
    }
    return names.mapIndexed { i, name -> Stage(name, i < index, i == index) }
  }

  /** What the engine is doing right now, in words. */
  private fun stepText(step: String, symbol: String): String =
    when (step) {
      "assets" -> "Loading the supported assets"
      "sourceChain" -> "Reading your funding wallet"
      "targetChain" -> "Reading the $symbol token"
      "holdings" -> "Reading your holder wallets"
      "recoveryScan" -> "Scanning your wallets"
      "fundingProbe" -> "Checking the private route"
      "fundingQuote" -> "Getting a funding quote"
      "fundingPrepare" -> "Preparing the sponsored transfer"
      "payoutEstimate" -> "Estimating the payouts"
      "fusionEstimate" -> "Checking the market price"
      "review" -> "Waiting for your approval"
      "nextSourceReview" -> "Waiting for your approval of the next source"
      "fundingSign" -> "Signing the transfer"
      "fundingSubmit" -> "Sending the transfer"
      "fundingReceipt" -> "Waiting for the transfer to confirm"
      "credit" -> "Waiting for the private balance to be credited"
      "authSalt",
      "authenticate",
      "balances" -> "Checking your private balance"
      "payoutQuote" -> "Getting a payout quote"
      "payoutIntent" -> "Signing a payout"
      "payoutSubmit" -> "Submitting a payout"
      "payoutStatus" -> "Waiting for a payout to arrive"
      "payoutBalance" -> "Confirming the payout arrived"
      "sellQuote" -> "Getting the private deposit quote"
      "fusionBalance",
      "fusionPreview" -> "Pricing the $symbol order"
      "fusionPermit" -> "Signing a token permit"
      "fusionOrder" -> "Building the order"
      "fusionSign" -> "Signing the order"
      "fusionSubmit" -> "Submitting the order"
      "fusionStatus" -> "Waiting for the order to fill"
      "fusionReceipts" -> "Checking the fill"
      "fusionAfter" -> "Confirming the balances"
      "done" -> "Finishing up"
      else ->
        step.replace(Regex("([a-z])([A-Z])"), "$1 $2").lowercase().replaceFirstChar { it.uppercase() }
    }

  fun progress(context: Context, view: Map<String, Any?>, approved: Boolean): View {
    val symbol = (view["targetSymbol"] as? String).orEmpty().ifBlank { "token" }
    val sell = view["direction"] == "sell"
    val legs = number(view, "legs", 3).coerceAtLeast(1)
    // A sell sells from its holders and pays out to `legs` fresh wallets.
    val sales = number(view, "holders", legs).coerceAtLeast(1)
    val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

    val badges = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    badges.addView(
      chip(
        context,
        when {
          sell -> "SELLING"
          else -> "BUYING"
        },
        NativeStyle.neon,
        neonFill,
      )
    )
    if (symbol != "token")
      badges.addView(
        chip(context, symbol, NativeStyle.primaryText, NativeStyle.glassSoft, NativeStyle.glassBorder),
        LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(context, 8) },
      )
    column.addView(badges)

    column.addView(
      NativeStyle.title(context, if (approved) "Swap in progress" else "Preparing the swap", 26f),
      params(context, 16),
    )
    val stepRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    stepRow.gravity = Gravity.CENTER_VERTICAL
    stepRow.addView(spinner(context), LinearLayout.LayoutParams(dp(context, 18), dp(context, 18)))
    stepRow.addView(
      text(
        context,
        stepText(view["step"] as? String ?: "", symbol),
        15f,
        NativeStyle.primaryText,
      ),
      LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(context, 10) },
    )
    column.addView(stepRow, params(context, 10))

    // Stages
    val stages = card(context)
    for ((i, stage) in stages(view).withIndex())
      stages.addView(stageRow(context, stage), params(context, if (i == 0) 0 else 14))
    column.addView(stages, params(context, 20))

    // Counters
    val paidLabel = if (sell) "USDC payouts sent" else "Wallets paid"
    val filledLabel = if (sell) "Sales filled" else "Stock orders filled"
    val counters = card(context)
    counters.addView(
      counter(context, paidLabel, number(view, "payoutsSubmitted"), legs)
    )
    counters.addView(
      counter(context, filledLabel, number(view, "ordersComplete"), if (sell) sales else legs),
      params(context, 14),
    )
    column.addView(counters, params(context, 12))

    val note = card(context, NativeStyle.glassSoft, NativeStyle.glassBorder)
    note.addView(
      text(
        context,
        if (approved)
          "Keep this screen open until it finishes."
        else "Nothing is signed yet. Leaving now cancels this preparation.",
        13f,
      )
    )
    column.addView(note, params(context, 12))

    // The raw engine position stays available for support, but out of the way.
    column.addView(
      text(
        context,
        "${view["phase"]} · ${view["step"]}",
        11f,
        NativeStyle.disabledText,
      ),
      params(context, 12),
    )
    return ScrollView(context).apply {
      isVerticalScrollBarEnabled = false
      addView(column)
    }
  }

  private fun stageRow(context: Context, stage: Stage): View {
    val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    row.gravity = Gravity.CENTER_VERTICAL
    val size = dp(context, 24)
    val dot =
      TextView(context).apply {
        gravity = Gravity.CENTER
        textSize = 12f
        typeface = NativeStyle.font(context, true)
        when {
          stage.done -> {
            text = "✓"
            setTextColor(NativeStyle.ctaText)
            background = GradientDrawable().apply {
              shape = GradientDrawable.OVAL
              setColor(NativeStyle.neon)
            }
          }
          stage.current -> {
            text = "•"
            setTextColor(NativeStyle.neon)
            background = GradientDrawable().apply {
              shape = GradientDrawable.OVAL
              setColor(neonFill)
              setStroke(dp(context, 2), NativeStyle.neon)
            }
          }
          else -> {
            background = GradientDrawable().apply {
              shape = GradientDrawable.OVAL
              setColor(Color.TRANSPARENT)
              setStroke(dp(context, 1), NativeStyle.glassBorder)
            }
          }
        }
      }
    row.addView(dot, LinearLayout.LayoutParams(size, size))
    row.addView(
      text(
        context,
        stage.title,
        15f,
        when {
          stage.current -> NativeStyle.neon
          stage.done -> NativeStyle.primaryText
          else -> NativeStyle.disabledText
        },
        stage.current,
      ),
      LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(context, 12) },
    )
    return row
  }

  private fun counter(context: Context, label: String, done: Int, total: Int): View {
    val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    val head = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    head.addView(text(context, label, 14f, NativeStyle.primaryText), LinearLayout.LayoutParams(0, -2, 1f))
    head.addView(text(context, "$done / $total", 14f, NativeStyle.secondary, true))
    column.addView(head)
    val bar =
      ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
        max = total
        progress = done.coerceIn(0, total)
        progressTintList = ColorStateList.valueOf(NativeStyle.neon)
        progressBackgroundTintList = ColorStateList.valueOf(NativeStyle.glassPressed)
      }
    column.addView(bar, LinearLayout.LayoutParams(-1, dp(context, 8)).apply { topMargin = dp(context, 8) })
    return column
  }

  // ── Review ─────────────────────────────────────────────────────────────────────────────

  /** The review text as cards. Every paragraph is shown in full and in the original order. */
  fun review(context: Context, review: String): View {
    val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    val paragraphs = review.trim().split(Regex("\n\\s*\n")).filter { it.isNotBlank() }
    for ((i, paragraph) in paragraphs.withIndex()) {
      val lines = paragraph.trim('\n').split('\n')
      val view =
        when {
          i == 0 -> header(context, lines)
          paragraph.trimStart().startsWith("PRIVACY") ->
            notice(context, "PRIVACY", paragraph.trim(), warm, warmFill, warmBorder)
          paragraph.trimStart().startsWith("SEND ALL PROCEEDS") ||
            paragraph.trimStart().startsWith("TOO SMALL") ->
            notice(
              context,
              if (paragraph.trimStart().startsWith("SEND")) "DESTINATION" else "LEFT IN PLACE",
              paragraph.trim(),
              NativeStyle.danger,
              dangerFill,
              NativeStyle.dangerBorder,
            )
          paragraph.contains("One approval authorizes") || paragraph.startsWith("Fusion limit") ->
            notice(
              context,
              "TERMS",
              paragraph.trim(),
              NativeStyle.secondary,
              NativeStyle.glassSoft,
              NativeStyle.glassBorder,
            )
          else -> block(context, lines)
        }
      column.addView(view, params(context, if (i == 0) 0 else 12))
    }
    return column
  }

  private fun header(context: Context, lines: List<String>): View {
    val box = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    box.addView(chip(context, lines.first().trim(), NativeStyle.neon, neonFill))
    lines.getOrNull(1)?.let {
      box.addView(
        text(context, it.trim(), 19f, NativeStyle.primaryText, true),
        params(context, 14),
      )
    }
    for (rest in lines.drop(2))
      box.addView(text(context, rest.trim(), 14f), params(context, 6))
    return box
  }

  private fun notice(
    context: Context,
    label: String,
    body: String,
    color: Int,
    fill: Int,
    border: Int,
  ): View {
    val card = card(context, fill, border)
    card.addView(chip(context, label, color, Color.TRANSPARENT))
    card.addView(text(context, body, 13.5f, color), params(context, 6))
    return card
  }

  /** A group of lines. A first line like "Payout 1 of 3 …" or "Wallet 0x…" becomes the heading. */
  private fun block(context: Context, lines: List<String>): View {
    val card = card(context)
    val heading =
      lines.size > 1 &&
        Regex("^(Payout|Leg|Wallet|Target|Selling|Funding)\\b").containsMatchIn(lines.first().trim())
    for ((i, line) in lines.withIndex()) {
      val first = i == 0 && heading
      card.addView(
        text(
          context,
          line.trim(),
          if (first) 15f else 14f,
          if (first) NativeStyle.primaryText else NativeStyle.secondary,
          first,
        ),
        params(context, if (i == 0) 0 else 6),
      )
    }
    return card
  }
}
