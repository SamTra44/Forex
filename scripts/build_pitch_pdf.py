"""
Investor Pitch PDF generator for QuantEdge.
Run:  python scripts/build_pitch_pdf.py
Outputs: public/QuantEdge-Investor-Pitch.pdf
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Frame, KeepTogether
)
from reportlab.platypus.flowables import HRFlowable
from reportlab.pdfgen.canvas import Canvas

# --- Brand palette ---
BG       = colors.HexColor('#0a0e17')
PANEL    = colors.HexColor('#161e2e')
LINE     = colors.HexColor('#1f2937')
ACCENT   = colors.HexColor('#22d3a7')
ACCENT2  = colors.HexColor('#3b82f6')
YELLOW   = colors.HexColor('#facc15')
DANGER   = colors.HexColor('#ef4444')
TEXT     = colors.HexColor('#e5e7eb')
MUTED    = colors.HexColor('#9ca3af')
DIM      = colors.HexColor('#6b7280')

PAGE_W, PAGE_H = A4

# --- Stylesheet ---
def make_styles():
    ss = getSampleStyleSheet()
    ss.add(ParagraphStyle(name='Hero',       fontName='Helvetica-Bold', fontSize=44, leading=50, textColor=ACCENT, alignment=1))
    ss.add(ParagraphStyle(name='HeroSub',    fontName='Helvetica',      fontSize=14, leading=18, textColor=MUTED, alignment=1))
    ss.add(ParagraphStyle(name='HeroTag',    fontName='Helvetica-Bold', fontSize=10, leading=14, textColor=YELLOW, alignment=1))
    ss.add(ParagraphStyle(name='H1',         fontName='Helvetica-Bold', fontSize=22, leading=28, textColor=ACCENT, spaceAfter=4))
    ss.add(ParagraphStyle(name='H2',         fontName='Helvetica-Bold', fontSize=14, leading=18, textColor=YELLOW, spaceBefore=8, spaceAfter=4))
    ss.add(ParagraphStyle(name='Body',       fontName='Helvetica',      fontSize=10.5, leading=15, textColor=TEXT, spaceAfter=6))
    ss.add(ParagraphStyle(name='BodyMuted',  fontName='Helvetica',      fontSize=10, leading=14, textColor=MUTED))
    ss.add(ParagraphStyle(name='QBullet',    fontName='Helvetica',      fontSize=10.5, leading=15, textColor=TEXT, leftIndent=14, bulletIndent=2, spaceAfter=2))
    ss.add(ParagraphStyle(name='Pull',       fontName='Helvetica-Bold', fontSize=12, leading=18, textColor=ACCENT, alignment=0))
    ss.add(ParagraphStyle(name='Footer',     fontName='Helvetica',      fontSize=8, leading=10, textColor=DIM, alignment=1))
    ss.add(ParagraphStyle(name='Disclaimer', fontName='Helvetica-Oblique', fontSize=8, leading=11, textColor=DIM, alignment=0))
    return ss

S = make_styles()

# --- Page chrome (background, header, footer) drawn for every page ---
def draw_chrome(canvas: Canvas, doc):
    canvas.saveState()
    # Solid dark background
    canvas.setFillColor(BG)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    # Top accent bar
    canvas.setFillColor(ACCENT)
    canvas.rect(0, PAGE_H - 4*mm, PAGE_W, 4*mm, fill=1, stroke=0)
    # Header brand strip
    canvas.setFont('Helvetica-Bold', 9)
    canvas.setFillColor(ACCENT)
    canvas.drawString(15*mm, PAGE_H - 12*mm, 'QuantEdge')
    canvas.setFillColor(MUTED)
    canvas.setFont('Helvetica', 8)
    canvas.drawString(35*mm, PAGE_H - 12*mm, '·  algorithmic trading platform')
    canvas.setFillColor(DIM)
    canvas.drawRightString(PAGE_W - 15*mm, PAGE_H - 12*mm, 'INVESTOR PROPOSITION  ·  Confidential')
    # Footer
    canvas.setFillColor(LINE)
    canvas.rect(15*mm, 14*mm, PAGE_W - 30*mm, 0.4*mm, fill=1, stroke=0)
    canvas.setFillColor(MUTED)
    canvas.setFont('Helvetica', 8)
    canvas.drawString(15*mm, 9*mm, 'QuantEdge  ·  www.quantedge.tech')
    canvas.drawRightString(PAGE_W - 15*mm, 9*mm, f'Page {doc.page}')
    canvas.restoreState()

# --- Reusable building blocks ---
def stat_tile(label, value, sub=None, value_color=ACCENT):
    """3-row mini card used in stat strips."""
    label_p = Paragraph(f'<font size="8" color="#9ca3af">{label.upper()}</font>', S['BodyMuted'])
    value_p = Paragraph(
        f'<font size="22" name="Helvetica-Bold" color="{value_color.hexval()}">{value}</font>',
        S['Body']
    )
    sub_p = Paragraph(f'<font size="8" color="#6b7280">{sub or ""}</font>', S['BodyMuted'])
    t = Table([[label_p], [value_p], [sub_p]], colWidths=[37*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), PANEL),
        ('BOX',        (0, 0), (-1, -1), 0.4, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING',(0, 0), (-1, -1), 8),
        ('TOPPADDING',  (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING',(0, 0), (-1, -1), 6),
    ]))
    return t

def stats_strip(items):
    """A row of stat_tile cards."""
    cells = [[stat_tile(*it) for it in items]]
    t = Table(cells, colWidths=[40*mm] * len(items))
    t.setStyle(TableStyle([
        ('VALIGN', (0,0),(-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0),(-1,-1), 0),
        ('RIGHTPADDING',(0,0),(-1,-1), 4),
    ]))
    return t

def panel(title, body_paragraphs, color=ACCENT):
    """Bordered content panel."""
    rows = [[Paragraph(f'<font color="{color.hexval()}" size="11" name="Helvetica-Bold">{title.upper()}</font>', S['Body'])]]
    for p in body_paragraphs:
        rows.append([p])
    t = Table(rows, colWidths=[170*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0),(-1,-1), PANEL),
        ('BOX',        (0,0),(-1,-1), 0.4, LINE),
        ('LEFTPADDING', (0,0),(-1,-1), 12),
        ('RIGHTPADDING',(0,0),(-1,-1), 12),
        ('TOPPADDING',  (0,0),(0,0),  10),
        ('BOTTOMPADDING',(0,-1),(-1,-1), 10),
        ('LINEBELOW', (0,0),(0,0), 0.3, LINE),
    ]))
    return t

def two_col_panels(left, right):
    """Two side-by-side panels."""
    t = Table([[left, right]], colWidths=[83*mm, 83*mm])
    t.setStyle(TableStyle([
        ('VALIGN', (0,0),(-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0),(-1,-1), 0),
        ('RIGHTPADDING',(0,0),(0,0),   3),
        ('LEFTPADDING', (1,0),(1,0),   3),
    ]))
    return t

def bullets(items, color=ACCENT):
    out = []
    for it in items:
        out.append(Paragraph(f'<font color="{color.hexval()}">▸</font>  {it}', S['QBullet']))
    return out

# --- Build story ---
def build():
    out_path = os.path.join('public', 'QuantEdge-Investor-Pitch.pdf')
    os.makedirs('public', exist_ok=True)
    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        leftMargin=15*mm, rightMargin=15*mm,
        topMargin=22*mm,  bottomMargin=18*mm,
        title='QuantEdge Investor Proposition',
        author='QuantEdge',
        subject='Algorithmic trading platform — investor pitch',
    )
    story = []

    # ==== COVER ====
    story.append(Spacer(1, 38*mm))
    story.append(Paragraph('QuantEdge', S['Hero']))
    story.append(Spacer(1, 4*mm))
    story.append(Paragraph('Algorithmic trading, productised.', S['HeroSub']))
    story.append(Spacer(1, 10*mm))
    story.append(Paragraph('INVESTOR PROPOSITION  ·  v1.0  ·  CONFIDENTIAL', S['HeroTag']))

    story.append(Spacer(1, 18*mm))
    story.append(stats_strip([
        ('Daily target',     '0.70%',  'compounding net of fees', ACCENT),
        ('Bot accuracy',     '99%',    'TP-hit rate, multi-strategy', YELLOW),
        ('Market venues',    '12+',    'forex · crypto · stocks · indices', ACCENT2),
        ('Min capital',      '$50',    'first-deposit qualifier', ACCENT),
    ]))

    story.append(Spacer(1, 14*mm))
    story.append(Paragraph(
        'A managed-strategy platform that runs an always-on multi-venue execution bot for retail investors. '
        'Capital is deposited as USDT (TRC-20), trading P&amp;L is booked daily, withdrawals settle in 24 hours. '
        'Referrals and joining bonuses are paid into separate wallets that mature into payouts.',
        S['Body']
    ))

    story.append(Spacer(1, 8*mm))
    story.append(panel('At a glance', [
        Paragraph('A turn-key on-platform funnel: <b>signup → KYC → deposit → daily booking → withdraw</b>. The trader never picks a pair, never times a session, never manages risk. The platform does — every day, automatically.', S['Body']),
    ], color=YELLOW))

    story.append(PageBreak())

    # ==== EXECUTIVE SUMMARY ====
    story.append(Paragraph('Executive Summary', S['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=2, spaceAfter=10))

    story.append(Paragraph(
        'QuantEdge is an algorithmic trading platform that gives retail investors institution-grade execution without the learning curve. '
        'Investors deposit USDT, and a multi-strategy bot books a target return every business day across 12+ market venues — '
        'forex, crypto, equities, indices and commodities — using risk-managed entries.',
        S['Body']
    ))
    story.append(Spacer(1, 4*mm))
    story.append(Paragraph(
        'The product is live, fully self-served, and built on a Node + SQLite stack with persistent storage, automated backups, '
        'and a portable database design that can be migrated host-to-host without losing a single user, transaction or referral.',
        S['Body']
    ))

    story.append(Spacer(1, 8*mm))
    story.append(stats_strip([
        ('Daily booking',  '0.70%',  'of capital, every weekday', ACCENT),
        ('Monthly target', '~22%',   '0.7% × 30 (compounding)',   YELLOW),
        ('Withdraw fee',   '20%',    '25% within first 60 days',  ACCENT2),
        ('Settlement',     '24 hr',  'TRC-20, on-chain',          ACCENT),
    ]))

    story.append(Spacer(1, 8*mm))
    story.append(panel('Why now', [
        Paragraph(
            'Retail demand for managed crypto/forex strategies has crossed the gap from speculation to <i>passive income</i>. '
            'QuantEdge productises that demand with a daily-booking model, transparent receipts, and a referral economy that '
            'compounds AUM faster than paid acquisition.',
            S['Body']),
    ], color=ACCENT))

    story.append(PageBreak())

    # ==== HOW IT WORKS ====
    story.append(Paragraph('How the System Works', S['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=2, spaceAfter=10))
    story.append(Paragraph('A clean five-stage pipeline that never asks the investor to make a trading decision.', S['BodyMuted']))
    story.append(Spacer(1, 4*mm))

    flow = [
        ('1.  Sign up & KYC',
         'User signs up with email + optional referral code, uploads Aadhar, PAN and a selfie. Admin approves within 24 hrs.'),
        ('2.  Deposit USDT (TRC-20)',
         'User sends USDT from any exchange (Binance, OKX, etc.) to the platform’s configured TRC-20 address and uploads a screenshot proof.'),
        ('3.  Admin verifies & credits',
         'Admin reviews the proof + on-chain TXID. On approval, the trading balance is credited at the live USDT/USD rate.'),
        ('4.  Bot books 0.70% daily',
         'Every business day, a multi-strategy execution bot books 0.70% of effective capital across 12+ venues, split into TP-hit trades.'),
        ('5.  Withdraw whenever',
         'KYC-verified users withdraw to their own TRC-20 wallet. Net amount lands within 24 hrs, after a transparent transaction fee.'),
    ]
    for title, body in flow:
        story.append(panel(title, [Paragraph(body, S['Body'])], color=ACCENT))
        story.append(Spacer(1, 3*mm))

    story.append(Spacer(1, 4*mm))
    story.append(panel('What the investor sees on day one', [
        Paragraph(
            '<b>Mobile-first dashboard</b> — Trading USD, USDT wallet, Referral Commission, Joining Bonus, '
            'Today’s P&amp;L, Bot Status — all visible at a glance.',
            S['Body']),
        Paragraph(
            '<b>Live TradingView chart</b> — embedded across crypto, forex, stocks and indices.',
            S['Body']),
        Paragraph(
            '<b>Daily / Weekly / Monthly / Yearly / Lifetime</b> profit history with win-rate and trade count.',
            S['Body']),
        Paragraph(
            '<b>Branded transaction receipts</b> — every deposit and withdrawal redirects to a screenshotable confirmation page, '
            'designed for sharing on WhatsApp / Telegram.',
            S['Body']),
    ], color=YELLOW))

    story.append(PageBreak())

    # ==== MARKETS WE TRADE ====
    story.append(Paragraph('Markets We Trade', S['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=2, spaceAfter=10))
    story.append(Paragraph('The bot routes capital across five asset classes for diversification — '
                           'capital is never concentrated in a single venue.', S['BodyMuted']))
    story.append(Spacer(1, 4*mm))

    markets = [
        ('Forex',      'EUR/USD · GBP/USD · USD/JPY · AUD/USD · USD/CAD',  ACCENT),
        ('Crypto',     'BTC/USDT · ETH/USDT · SOL/USDT · BNB/USDT · XRP', YELLOW),
        ('Equities',   'AAPL · MSFT · NVDA · TSLA · AMZN',                ACCENT2),
        ('Indices',    'NAS100 · SPX500 · DJI · DAX40',                   ACCENT),
        ('Commodities','XAU/USD (Gold) · XAG/USD (Silver) · WTI Oil',     YELLOW),
    ]
    rows = [[Paragraph(f'<font color="{c.hexval()}" name="Helvetica-Bold">{name}</font>',     S['Body']),
             Paragraph(f'<font color="#e5e7eb">{symbols}</font>', S['Body'])] for name, symbols, c in markets]
    t = Table(rows, colWidths=[35*mm, 135*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0),(-1,-1), PANEL),
        ('GRID',       (0,0),(-1,-1), 0.3, LINE),
        ('LEFTPADDING', (0,0),(-1,-1), 12),
        ('RIGHTPADDING',(0,0),(-1,-1), 12),
        ('TOPPADDING',  (0,0),(-1,-1), 10),
        ('BOTTOMPADDING',(0,0),(-1,-1), 10),
        ('VALIGN',     (0,0),(-1,-1), 'MIDDLE'),
    ]))
    story.append(t)

    story.append(Spacer(1, 8*mm))
    story.append(panel('Execution venues', [
        Paragraph('Order routing connects to <b>12+ liquidity sources</b> across the listed asset classes. '
                  'For crypto, depth is sourced from Binance, Coinbase, OKX, Bybit and Kraken; '
                  'forex and indices use ECN aggregators with multi-broker price discovery; '
                  'equities trade on NASDAQ-routed venues with smart-order routing.', S['Body']),
    ], color=ACCENT))

    story.append(PageBreak())

    # ==== BOT ARCHITECTURE / ACCURACY ====
    story.append(Paragraph('Bot Architecture &amp; Accuracy', S['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=2, spaceAfter=10))

    story.append(Paragraph('A pre-trained ensemble that fires only when conviction is high. '
                           'Accuracy across the live trade window is <b>99%</b> TP-hit rate, audited per-user in the '
                           'Trade History panel of the dashboard.', S['Body']))

    story.append(Spacer(1, 4*mm))
    story.append(stats_strip([
        ('TP hit rate',     '99%',  'across all live users',     ACCENT),
        ('Daily trades',    '2',    'split-target booking',      YELLOW),
        ('Slippage',        '<0.05%','aggregated venues',        ACCENT2),
        ('Drawdown cap',    '0.5%', 'per-day, hard-stopped',     DANGER),
    ]))

    story.append(Spacer(1, 6*mm))
    story.append(two_col_panels(
        panel('Strategy stack', [
            Paragraph('<b>Mean-reversion</b> on intraday Z-score outliers', S['Body']),
            Paragraph('<b>Momentum continuation</b> on EMA-9 / EMA-21 cross with volume confirmation', S['Body']),
            Paragraph('<b>Order-flow imbalance</b> on L2 depth deltas', S['Body']),
            Paragraph('<b>Volatility breakout</b> on ATR(14) compression', S['Body']),
        ], color=ACCENT),
        panel('Risk engine', [
            Paragraph('Per-user daily P&amp;L locked to <b>+0.70% target</b>', S['Body']),
            Paragraph('Per-trade size capped to <b>≤ 0.5×</b> of remaining day target', S['Body']),
            Paragraph('Hard stop if floating drawdown &gt; <b>0.5%</b> of capital', S['Body']),
            Paragraph('Capital protection: balance never falls below <b>$1</b>', S['Body']),
        ], color=YELLOW),
    ))

    story.append(Spacer(1, 8*mm))
    story.append(panel('Why 99% accuracy is sustainable', [
        Paragraph(
            'The bot does not chase every signal. It is gated by an <b>edge filter</b> that only fires when the ensemble '
            'returns &gt; 1.4σ confidence. That sacrifices opportunity count to maximise hit rate — by design we accept '
            'fewer trades for a higher TP-hit ratio. The product is paid on <i>consistency</i>, not on raw return chasing.',
            S['Body']),
    ], color=ACCENT))

    story.append(PageBreak())

    # ==== RETURNS PROFILE ====
    story.append(Paragraph('Daily Returns Profile', S['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=2, spaceAfter=10))

    story.append(Paragraph(
        'Daily booking is fixed at <b>0.70% of effective capital</b>. With compounding (P&amp;L re-invested every day), '
        'monthly and yearly returns project as follows:', S['Body']))

    table_data = [
        ['Period',         'Compound rate',   'On $100',     'On $1,000',    'On $10,000'],
        ['Daily',          '0.70%',           '$0.70',       '$7.00',        '$70.00'],
        ['Weekly (5d)',    '3.55%',           '$103.55',     '$1,035.50',    '$10,355.00'],
        ['Monthly (22d)',  '~16.62%',         '$116.62',     '$1,166.20',    '$11,662.00'],
        ['Quarterly',      '~58.50%',         '$158.50',     '$1,585.00',    '$15,850.00'],
        ['Annual (252d)',  '~478%',           '$578.00',     '$5,780.00',    '$57,800.00'],
    ]
    t = Table(table_data, colWidths=[36*mm, 28*mm, 32*mm, 36*mm, 38*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0),    ACCENT),
        ('TEXTCOLOR',  (0, 0), (-1, 0),    BG),
        ('FONTNAME',   (0, 0), (-1, 0),    'Helvetica-Bold'),
        ('FONTSIZE',   (0, 0), (-1, 0),    10),
        ('FONTSIZE',   (0, 1), (-1, -1),   10),
        ('FONTNAME',   (0, 1), (-1, -1),   'Helvetica'),
        ('TEXTCOLOR',  (0, 1), (-1, -1),   TEXT),
        ('TEXTCOLOR',  (1, 1), (1, -1),    YELLOW),
        ('TEXTCOLOR',  (2, 1), (-1, -1),   ACCENT),
        ('FONTNAME',   (2, 1), (-1, -1),   'Helvetica-Bold'),
        ('BACKGROUND', (0, 1), (-1, -1),   PANEL),
        ('GRID',       (0, 0), (-1, -1),   0.3, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1),  10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING',  (0, 0), (-1, -1),  9),
        ('BOTTOMPADDING',(0, 0), (-1, -1), 9),
    ]))
    story.append(t)

    story.append(Spacer(1, 6*mm))
    story.append(panel('Two payout paths', [
        Paragraph('<b>Cash-out</b> — withdraw to user’s own TRC-20 USDT wallet. 20% transaction fee, 25% if within first 60 days. Settles in 24 hrs.', S['Body']),
        Paragraph('<b>Compound</b> — leave the booked P&amp;L in the trading balance. Next day’s 0.70% is computed on the new larger base, accelerating returns.', S['Body']),
    ], color=YELLOW))

    story.append(PageBreak())

    # ==== REFERRAL ECONOMY ====
    story.append(Paragraph('Referral Economy', S['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=2, spaceAfter=10))

    story.append(Paragraph(
        'Two distinct on-platform wallets create a referral funnel that <b>compounds AUM faster than paid acquisition</b>.',
        S['Body']))

    story.append(Spacer(1, 4*mm))
    story.append(two_col_panels(
        panel('Referral Commission Wallet', [
            Paragraph('<b>5%</b> of every referee\'s first $50+ deposit', S['Body']),
            Paragraph('<b>+ $10</b> achievement bonus on 3 qualifying referrals within 60 days', S['Body']),
            Paragraph('Withdraws to USDT after KYC — minimum balance $45', S['Body']),
        ], color=YELLOW),
        panel('Joining Bonus Wallet', [
            Paragraph('<b>5% signup bonus</b> on the user\'s own first qualifying deposit', S['Body']),
            Paragraph('Admin can top this up directly to incentivise specific cohorts', S['Body']),
            Paragraph('Withdraws to USDT after KYC — minimum balance $45', S['Body']),
        ], color=ACCENT),
    ))

    story.append(Spacer(1, 6*mm))
    story.append(panel('Worked example', [
        Paragraph('A user invites 3 friends, each deposits $500.', S['BodyMuted']),
        Paragraph('Commission: 3 × $25 = <b>$75</b> · Achievement: <b>$10</b> · Their own join bonus on $500: <b>$25</b>', S['Body']),
        Paragraph('<b>Total earned:</b> $110 — entirely funded by the depositor base, no external CAC.', S['Pull']),
    ], color=ACCENT))

    story.append(PageBreak())

    # ==== SECURITY / KYC / OPS ====
    story.append(Paragraph('Security, KYC &amp; Operations', S['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=2, spaceAfter=10))

    story.append(two_col_panels(
        panel('User-side controls', [
            Paragraph('JWT-signed sessions with rotation', S['Body']),
            Paragraph('bcrypt password hashing', S['Body']),
            Paragraph('KYC: Aadhar + PAN + Selfie review by admin', S['Body']),
            Paragraph('Withdrawals locked behind <b>KYC-approved</b> status', S['Body']),
            Paragraph('Mobile number captured during KYC for support', S['Body']),
        ], color=ACCENT),
        panel('Platform-side controls', [
            Paragraph('SQLite with daily auto-snapshots (kept 7 days)', S['Body']),
            Paragraph('Hot-backup download anytime from Admin Console', S['Body']),
            Paragraph('Restore-on-restart staging — DB swap with safety bak', S['Body']),
            Paragraph('Cache-busting headers on app shell — instant deploys', S['Body']),
            Paragraph('Host-agnostic: <b>migrates between Railway / Render / VPS</b> in 3 steps', S['Body']),
        ], color=YELLOW),
    ))

    story.append(Spacer(1, 8*mm))
    story.append(panel('Withdrawal logic (transparent &amp; auditable)', [
        Paragraph('1.  User enters USD amount + their TRC-20 address', S['Body']),
        Paragraph('2.  Live quote: gross / fee / net USD / net USDT', S['Body']),
        Paragraph('3.  Submit → trading balance debited, request goes to admin', S['Body']),
        Paragraph('4.  Admin sends USDT on-chain, marks the request with TXID', S['Body']),
        Paragraph('5.  User receives a <b>branded receipt</b> at every step — screenshot-ready for share', S['Body']),
    ], color=ACCENT))

    story.append(PageBreak())

    # ==== CALL TO ACTION ====
    story.append(Spacer(1, 30*mm))
    story.append(Paragraph('Get Started', S['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=2, spaceAfter=18))

    story.append(stats_strip([
        ('Min deposit', '$50',   'TRC-20 USDT',         ACCENT),
        ('First payout','24 hr', 'after admin verify',  YELLOW),
        ('Daily ROI',   '0.70%', 'compounding',         ACCENT2),
        ('KYC',         '24 hr', 'Aadhar + PAN + selfie', ACCENT),
    ]))

    story.append(Spacer(1, 14*mm))
    story.append(panel('Three steps to live', [
        Paragraph('<b>1.  Open</b> the QuantEdge dashboard, sign up, complete KYC.', S['Body']),
        Paragraph('<b>2.  Deposit</b> $50+ USDT (TRC-20) to the platform address — upload screenshot.', S['Body']),
        Paragraph('<b>3.  Wait one business day.</b> 0.70% appears in your account, every day, automatically.', S['Body']),
    ], color=ACCENT))

    story.append(Spacer(1, 12*mm))
    story.append(Paragraph(
        '<b>Disclaimer.</b> Returns shown are projections based on platform-target booking. Past performance is not '
        'a guarantee of future results. All returns are net of execution slippage. Withdrawals subject to KYC and '
        'admin approval. By depositing capital you acknowledge the risk profile of algorithmic trading and the '
        'transaction fee schedule disclosed at withdrawal time.',
        S['Disclaimer']
    ))

    doc.build(story, onFirstPage=draw_chrome, onLaterPages=draw_chrome)
    size = os.path.getsize(out_path)
    print(f'OK -> {out_path} ({size:,} bytes)')

if __name__ == '__main__':
    build()
