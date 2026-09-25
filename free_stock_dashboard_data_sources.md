# Free Data Sources for a Long-Term Stock Analysis Dashboard

## Overview

For a long-term stock analysis dashboard, it is generally preferable to
source **raw financial statement data** and calculate valuation and
quality metrics yourself. This provides control over definitions and
avoids inconsistencies between providers.

For U.S. public companies, **SEC EDGAR** is an especially useful primary
source because it is free, official, requires no API key, and provides
XBRL company facts directly from company filings.

A practical free-data stack is:

-   **SEC EDGAR** --- company financial statements and filing data
-   **Alpha Vantage** --- stock prices and convenient normalized
    fundamentals
-   **Finnhub** --- peers and supplementary market/company data
-   **FRED** --- Treasury yields, interest rates, and economic data
-   **Your own calculations** --- valuation ratios, growth rates, ROIC,
    FCF, and scenarios

------------------------------------------------------------------------

## Data Sources by Dashboard Item

  -----------------------------------------------------------------------
  Dashboard item    Best free source  Other free        Calculate
                                      source(s)         yourself?
  ----------------- ----------------- ----------------- -----------------
  Revenue           SEC EDGAR Company Alpha Vantage     No
                    Facts             Income Statement  

  Revenue CAGR      SEC EDGAR         Alpha Vantage     **Yes**
  (5/10 yr)                                             

  EPS diluted       SEC EDGAR         Alpha Vantage     Usually no
                                      Earnings          

  EPS CAGR          SEC EDGAR         Alpha Vantage     **Yes**

  Operating income  SEC EDGAR         Alpha Vantage     No
                                      Income Statement  

  Operating margin  SEC EDGAR         Alpha Vantage     **Yes**

  Gross profit      SEC EDGAR         Alpha Vantage     No

  Gross margin      SEC EDGAR         Alpha Vantage     **Yes**

  Operating cash    SEC EDGAR         Alpha Vantage     No
  flow                                Cash Flow         

  Capital           SEC EDGAR         Alpha Vantage     No
  expenditures                        Cash Flow         

  Free cash flow    SEC EDGAR         Alpha Vantage     **Yes**

  FCF/share         SEC EDGAR         Alpha Vantage     **Yes**

  FCF/share CAGR    SEC EDGAR         Alpha Vantage     **Yes**

  FCF margin        SEC EDGAR         Alpha Vantage     **Yes**

  ROIC              SEC EDGAR         Finnhub / Alpha   **Prefer yes**
                                      Vantage inputs    

  Cash              SEC EDGAR         Alpha Vantage     No
                                      Balance Sheet     

  Total debt        SEC EDGAR         Alpha Vantage     No
                                      Balance Sheet     

  Net debt/cash     SEC EDGAR         Alpha Vantage     **Yes**

  Debt/FCF          SEC EDGAR         Alpha Vantage     **Yes**

  Shares            SEC EDGAR         Alpha Vantage     No
  outstanding                         Shares            
                                      Outstanding       

  Share-count       SEC EDGAR         Alpha Vantage     **Yes**
  change                                                

  Dividends/share   Alpha Vantage     SEC filings       Usually no

  Dividend growth   Alpha Vantage     SEC EDGAR         **Yes**

  Payout ratio      SEC +             Alpha Vantage     **Yes**
                    price/dividend                      
                    data                                

  Stock price       Alpha Vantage     Finnhub           No

  Historical stock  Alpha Vantage     Finnhub           No
  price                                                 

  Market cap        Price × shares    Alpha Vantage /   Prefer calculate
                                      Finnhub           

  P/E               Price + EPS       Alpha Vantage /   Prefer calculate
                                      Finnhub           

  Historical P/E    Price +           SEC + price API   **Yes**
                    historical EPS                      

  P/FCF             Price + FCF/share SEC + price API   **Yes**

  FCF yield         SEC + price API   ---               **Yes**

  Enterprise value  SEC + price API   FMP               **Yes**

  EV/EBIT           SEC + price API   FMP               **Yes**

  EV/EBITDA         SEC + price API   FMP               **Yes**

  WACC              SEC + market      FRED + SEC        **Yes**
                    data + Treasury                     
                    data                                

  ROIC − WACC       Above             ---               **Yes**

  Peer companies    Finnhub           ---               No

  Peer valuation    Finnhub + SEC     Alpha Vantage     Usually calculate

  Analyst EPS       Alpha Vantage     Finnhub           No
  estimates                                             

  Analyst revenue   Alpha Vantage     Finnhub           No
  estimates                                             

  DCF/intrinsic     SEC + market data ---               **Definitely
  value                                                 calculate**
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 1. SEC EDGAR --- Primary Fundamental Data Source

**Documentation:**\
https://www.sec.gov/search-filings/edgar-application-programming-interfaces

For U.S.-listed companies filing with the SEC, SEC EDGAR is a strong
foundation for the dashboard.

A particularly useful Company Facts endpoint is:

``` text
https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
```

It provides XBRL facts across company filings and does not require an
API key.

Useful raw values include:

-   Revenue
-   Net income
-   Operating income
-   Gross profit
-   Cash and equivalents
-   Assets
-   Liabilities
-   Debt
-   Shareholders' equity
-   Operating cash flow
-   Capital expenditures
-   Diluted EPS
-   Diluted weighted-average shares
-   Shares outstanding

### Metrics to Calculate

#### Free Cash Flow

``` text
FCF = Operating Cash Flow - Capital Expenditures
```

#### FCF per Share

``` text
FCF/share = FCF / Diluted Shares
```

#### FCF Yield

``` text
FCF Yield = FCF/share / Share Price
```

#### Operating Margin

``` text
Operating Margin = Operating Income / Revenue
```

Using the raw filing data lets you control exactly how each metric is
defined.

------------------------------------------------------------------------

## 2. Alpha Vantage --- Convenient Supplementary API

**Documentation:**\
https://www.alphavantage.co/documentation/

A free API key is required.

Useful endpoints include:

``` text
OVERVIEW
INCOME_STATEMENT
BALANCE_SHEET
CASH_FLOW
EARNINGS
SHARES_OUTSTANDING
```

Example requests:

``` text
/query?function=INCOME_STATEMENT&symbol=AAPL&apikey=KEY

/query?function=BALANCE_SHEET&symbol=AAPL&apikey=KEY

/query?function=CASH_FLOW&symbol=AAPL&apikey=KEY

/query?function=EARNINGS&symbol=AAPL&apikey=KEY
```

Alpha Vantage is considerably easier to work with than raw XBRL because
the financial statement information is normalized.

A good approach is to use it as either:

1.  A convenience layer over SEC data, or
2.  A cross-check against values extracted from SEC filings.

------------------------------------------------------------------------

## 3. Finnhub --- Peers and Supplementary Data

**Website:**\
https://finnhub.io/

Finnhub is useful for:

-   Company profiles
-   Peer companies
-   Basic financial metrics
-   Stock prices
-   Market data

Its company-peer functionality is particularly useful for the **peer
comparison** section of a dashboard.

Rather than manually maintaining a peer list, the application can
retrieve peer companies and then calculate the same valuation and
quality metrics for each one.

------------------------------------------------------------------------

## 4. Financial Modeling Prep (FMP)

**Website:**\
https://financialmodelingprep.com/

FMP can provide useful financial and market data, but its free tier
should be treated cautiously when designing the application because
access to fundamental statements, ratios, and historical data can vary
by plan.

It can be useful as a supplementary source, but a reasonable priority
order is:

``` text
SEC EDGAR
    ↓
Alpha Vantage
    ↓
Finnhub
    ↓
Financial Modeling Prep
```

Do not architect the application around an FMP endpoint without first
confirming that the endpoint is included in the current free tier.

------------------------------------------------------------------------

## 5. FRED --- Economic and Interest-Rate Data

**Website/API:**\
https://fred.stlouisfed.org/docs/api/fred/

The Federal Reserve Economic Data (FRED) API is useful for macroeconomic
and valuation inputs such as:

-   U.S. Treasury yields
-   Risk-free rates
-   Interest rates
-   Inflation
-   Economic indicators

This is particularly useful when calculating:

-   WACC
-   Discount rates
-   DCF valuations
-   Equity risk assumptions

------------------------------------------------------------------------

# Recommended Architecture

Rather than retrieving precomputed ratios from many different APIs,
store the underlying raw values and calculate metrics internally.

``` text
                  ┌──────────────────────┐
                  │      SEC EDGAR       │
                  │ Financial statements │
                  └──────────┬───────────┘
                             │
                             ▼
┌────────────────┐    ┌──────────────────────┐
│ Price API      │───▶│    Your database     │
│ Alpha Vantage  │    │                      │
└────────────────┘    │ Raw fundamentals     │
                      │ Raw prices            │
┌────────────────┐    │ Calculated metrics   │
│ Finnhub        │───▶│                      │
│ Peers/etc.     │    └──────────┬───────────┘
└────────────────┘               │
                                 ▼
                        ┌───────────────────┐
                        │     Dashboard     │
                        └───────────────────┘
```

------------------------------------------------------------------------

# Store Raw Data, Not Just Ratios

Avoid storing only calculated values such as:

``` text
AAPL
FCF Yield = 2.71%
```

Instead, store the raw financial information:

``` text
AAPL
FY2025

Revenue
Gross profit
Operating income
Net income
Operating cash flow
Capital expenditures
Cash
Debt
Diluted shares
EPS
```

Then calculate metrics from those values.

For example:

``` text
FCF
FCF/share
FCF margin
FCF yield

Revenue CAGR
EPS CAGR
FCF/share CAGR

Gross margin
Operating margin

ROIC
ROIC - WACC

Share-count CAGR

P/E
P/FCF
EV
EV/EBIT
EV/EBITDA
```

This has several advantages:

-   Consistent definitions across companies
-   Easier auditing and troubleshooting
-   Historical metrics can be recalculated
-   Formulas can be changed without downloading all data again
-   Multiple valuation methodologies can use the same underlying data

------------------------------------------------------------------------

# Suggested Free-Data Stack

## SEC EDGAR

Use for:

-   Income statements
-   Balance sheets
-   Cash-flow statements
-   EPS
-   Share counts
-   Historical fundamentals

## Alpha Vantage

Use for:

-   Current prices
-   Historical prices
-   Convenient normalized financial statements
-   Earnings data
-   Shares outstanding
-   Some forward-looking estimates

## Finnhub

Use for:

-   Peer identification
-   Company profiles
-   Supplementary market data
-   Supplementary financial metrics

## FRED

Use for:

-   Treasury yields
-   Risk-free rates
-   Interest rates
-   Economic data

## Calculate Internally

Calculate:

-   Revenue CAGR
-   EPS CAGR
-   FCF
-   FCF/share
-   FCF/share CAGR
-   FCF margin
-   FCF yield
-   Gross margin
-   Operating margin
-   ROIC
-   Net debt/cash
-   Debt/FCF
-   Share-count change
-   Dividend growth
-   Payout ratio
-   Historical P/E
-   P/FCF
-   Enterprise value
-   EV/EBIT
-   EV/EBITDA
-   WACC
-   ROIC − WACC
-   DCF/intrinsic value
-   Scenario-based expected returns

------------------------------------------------------------------------

# Key Limitation of Free APIs

The biggest weakness of a completely free data stack is generally
**forward-looking analyst consensus data**.

High-quality datasets containing:

-   Historical consensus estimates
-   Analyst estimate revisions
-   Long-term growth estimates
-   Detailed forward revenue/EPS estimates

are often commercial products.

For a dashboard focused primarily on long-term fundamental investing,
however, SEC EDGAR + Alpha Vantage + Finnhub + FRED can provide most of
the necessary raw information without paying for a fundamental-data
provider.
