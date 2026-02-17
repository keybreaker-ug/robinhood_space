from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import robin_stocks.robinhood as rh
import yfinance as yf
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta
from collections import defaultdict
from pyxirr import xirr
import pandas as pd
import os
import inspect
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
import threading
import pickle
from pathlib import Path

app = Flask(__name__, static_folder='.')
CORS(app)  # Enable CORS for local development

# Session configuration
SESSION_TIMEOUT_MINUTES = 45
PICKLE_FILE_PATH = Path(os.path.expanduser("~")) / ".tokens" / "robinhood.pickle"

# Global variable to store login state
logged_in = False
login_token = None
session_start_time = None  # Track when session started

# Caches
asset_metadata_cache = {}
instrument_cache = {}  # Cache for instrument URL -> symbol mapping
instrument_cache_lock = threading.Lock()

# Thread pool for concurrent API calls
executor = ThreadPoolExecutor(max_workers=10)


def check_existing_session():
    """Check if a valid pickle session file exists and is not expired"""
    global logged_in, session_start_time
    
    if not PICKLE_FILE_PATH.exists():
        return False
    
    try:
        # Check file modification time
        file_mtime = datetime.fromtimestamp(PICKLE_FILE_PATH.stat().st_mtime)
        age_minutes = (datetime.now() - file_mtime).total_seconds() / 60
        
        if age_minutes > SESSION_TIMEOUT_MINUTES:
            # Session expired, delete the file
            # delete_pickle_file()
            return False
        
        # Try to use the existing session
        # robin_stocks automatically uses the pickle file if it exists
        try:
            # Verify session is still valid by making a simple API call
            profile = rh.profiles.load_account_profile()
            if profile:
                logged_in = True
                session_start_time = file_mtime
                return True
        except Exception:
            # delete_pickle_file()
            return False
            
    except Exception:
        return False
    
    return False


def delete_pickle_file():
    """Delete the pickle session file"""
    global logged_in, session_start_time
    try:
        if PICKLE_FILE_PATH.exists():
            PICKLE_FILE_PATH.unlink()
        logged_in = False
        session_start_time = None
    except Exception as e:
        print(f"Error deleting pickle file: {e}")


def get_session_info():
    """Get current session information including time remaining"""
    global session_start_time
    
    if not logged_in or not session_start_time:
        return None
    
    elapsed = (datetime.now() - session_start_time).total_seconds()
    remaining_seconds = (SESSION_TIMEOUT_MINUTES * 60) - elapsed
    
    if remaining_seconds <= 0:
        return None
    
    return {
        'remaining_seconds': int(remaining_seconds),
        'timeout_minutes': SESSION_TIMEOUT_MINUTES
    }


def update_session_start_time():
    """Update the session start time to now (called on successful login)"""
    global session_start_time
    session_start_time = datetime.now()
    # Touch the pickle file to update its modification time
    if PICKLE_FILE_PATH.exists():
        PICKLE_FILE_PATH.touch()

@app.route('/')
def serve_index():
    """Serve the index.html file"""
    return send_from_directory('.', 'index.html')


@app.route('/api/check-session', methods=['GET'])
def check_session():
    """Check if there's a valid existing session"""
    global logged_in
    
    # First check if we're already logged in
    if logged_in:
        session_info = get_session_info()
        if session_info:
            return jsonify({
                'success': True,
                'logged_in': True,
                'session_info': session_info
            })
        else:
            # Session expired
            # delete_pickle_file()
            logged_in = False
    
    # Check for existing pickle file session
    if check_existing_session():
        session_info = get_session_info()
        return jsonify({
            'success': True,
            'logged_in': True,
            'session_info': session_info
        })
    
    return jsonify({
        'success': True,
        'logged_in': False,
        'session_info': None
    })


@app.route('/api/session-info', methods=['GET'])
def session_info_endpoint():
    """Get current session timing information"""
    if not logged_in:
        return jsonify({
            'success': False,
            'message': 'Not logged in'
        }), 401
    
    session_info = get_session_info()
    if not session_info:
        # delete_pickle_file()
        return jsonify({
            'success': False,
            'message': 'Session expired'
        }), 401
    
    return jsonify({
        'success': True,
        'session_info': session_info
    })

@app.route('/api/login', methods=['POST'])
def login():
    global logged_in, login_token, session_start_time

    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password')
    mfa_code = (data.get('mfa_code') or data.get('mfaCode') or '').strip()

    if not username or not password:
        return jsonify({
            'success': False,
            'message': 'Username and password are required'
        }), 400
    
    try:
        base_login_kwargs = {
            'username': username,
            'password': password,
            'store_session': True,
        }
        if mfa_code:
            base_login_kwargs['mfa_code'] = mfa_code

        try:
            login_signature = inspect.signature(rh.login)
            accepted_params = set(login_signature.parameters.keys())
            login_kwargs = {
                key: value for key, value in base_login_kwargs.items()
                if key in accepted_params
            }
            login_result = rh.login(**login_kwargs)
        except (TypeError, ValueError):
            # Fallback for environments where signature introspection or kwargs mismatch fails.
            login_result = rh.login(username, password)

        if isinstance(login_result, dict) and login_result.get('access_token'):
            logged_in = True
            login_token = login_result
            update_session_start_time()  # Set session start time
            session_info = get_session_info()
            return jsonify({
                'success': True,
                'message': 'Login successful',
                'requires_2fa': False,
                'session_info': session_info
            })

        if isinstance(login_result, dict):
            challenge = login_result.get('challenge')
            if login_result.get('mfa_required') or challenge:
                challenge_message = login_result.get('detail') or 'Two-factor authentication is required'
                return jsonify({
                    'success': False,
                    'message': challenge_message,
                    'requires_2fa': True
                }), 401

            detail_message = login_result.get('detail')
            if detail_message:
                return jsonify({
                    'success': False,
                    'message': detail_message,
                    'requires_2fa': False
                }), 401

        return jsonify({
            'success': False,
            'message': 'Login failed. Please verify your credentials and any Robinhood approval prompts.'
        }), 401

    except Exception as e:
        error_message = str(e)
        status_code = 500

        lower_error = error_message.lower()
        if 'invalid' in lower_error or 'unauthorized' in lower_error or 'authenticate' in lower_error:
            status_code = 401

        return jsonify({
            'success': False,
            'message': error_message
        }), status_code

@app.route('/api/portfolio', methods=['GET'])
def get_portfolio():
    global logged_in
    
    if not logged_in:
        return jsonify({
            'success': False,
            'message': 'Not logged in'
        }), 401
    
    try:
        # Fetch stock holdings
        holdings = rh.account.build_holdings()
        stocks_data = []
        
        for symbol, data in holdings.items():
            stock = {
                'Symbol': symbol,
                'Name': data['name'],
                'Quantity': float(data['quantity']),
                'Average Cost': float(data['average_buy_price']),
                'Current Price': float(data['price']),
                'Current Value': float(data['equity']),
                'Profit and Loss': float(data['equity']) - (float(data['quantity']) * float(data['average_buy_price'])),
            }
            stocks_data.append(stock)

        if not stocks_data:
            return jsonify({
                'success': True,
                'data': {
                    'stocks': [],
                    'sp500': None,
                    'historicalData': [],
                    'monthlyCashFlows': [],
                    'cashFlowTransactions': [],
                    'totalInvestment': 0,
                    'totalCurrentValue': 0,
                    'totalProfitLoss': 0,
                    'overallXirr': 0
                }
            })
        
        # OPTIMIZATION: Fetch orders ONCE and process all data from it
        orders = rh.orders.get_all_stock_orders()
        orders = orders[::-1]  # Reverse to chronological order
        
        # OPTIMIZATION: Batch fetch all unique instrument URLs concurrently
        unique_instruments = set(order['instrument'] for order in orders)
        prefetch_instruments(unique_instruments)
        
        # Process transactions using cached instrument data
        individual_orders, stock_ages, earliest_date = process_orders_optimized(orders)
        
        # Calculate XIRR and Investments
        overall_xirr, xirr_values, investments = calculate_xirr_investments(stocks_data, individual_orders)
        
        # OPTIMIZATION: Fetch S&P 500 data ONCE for both comparison and historical performance
        sp500_hist = fetch_sp500_history(earliest_date)
        
        # Calculate S&P 500 comparison using pre-fetched data
        sp500_data = calculate_sp500_comparison_optimized(earliest_date, sum(investments), sp500_hist)
        
        # Get historical performance data using pre-fetched S&P 500 data
        historical_data = get_historical_performance_optimized(individual_orders, earliest_date, sp500_hist)

        # Get monthly cash flow summary
        monthly_cash_flows = get_monthly_cash_flows(individual_orders)

        # Flatten all transaction cash flows for frontend aggregation/chart controls
        cash_flow_transactions = get_cash_flow_transactions(individual_orders)
        
        # OPTIMIZATION: Batch fetch asset metadata concurrently
        symbols_to_fetch = [(stock['Symbol'], stock['Name']) for stock in stocks_data]
        fetch_asset_metadata_batch(symbols_to_fetch)
        
        # Combine all data
        portfolio_stocks = []
        for stock, xirr_value, investment in zip(stocks_data, xirr_values, investments):
            metadata = asset_metadata_cache.get(stock['Symbol'], {'sector': 'Uncategorized', 'isEtf': False})
            portfolio_stocks.append({
                'name': stock['Name'],
                'symbol': stock['Symbol'],
                'quantity': stock['Quantity'],
                'avgCost': stock['Average Cost'],
                'currentPrice': stock['Current Price'],
                'investment': investment,
                'currentValue': stock['Current Value'],
                'profitLoss': stock['Profit and Loss'],
                'xirr': xirr_value,
                'timeHeld': stock_ages.get(stock['Symbol'], 'N/A'),
                'sector': metadata['sector'],
                'isEtf': metadata['isEtf']
            })
        
        total_investment = sum(investments)
        total_current_value = sum([s['Current Value'] for s in stocks_data])
        total_profit_loss = total_current_value - total_investment
        
        return jsonify({
            'success': True,
            'data': {
                'stocks': portfolio_stocks,
                'sp500': sp500_data,
                'historicalData': historical_data,
                'monthlyCashFlows': monthly_cash_flows,
                'cashFlowTransactions': cash_flow_transactions,
                'totalInvestment': total_investment,
                'totalCurrentValue': total_current_value,
                'totalProfitLoss': total_profit_loss,
                'overallXirr': overall_xirr
            }
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


def get_instrument_symbol(instrument_url):
    """Get symbol from instrument URL with caching"""
    with instrument_cache_lock:
        if instrument_url in instrument_cache:
            return instrument_cache[instrument_url]
    
    # If not cached, fetch it
    instrument_data = rh.stocks.get_instrument_by_url(instrument_url)
    symbol = instrument_data['symbol']
    
    with instrument_cache_lock:
        instrument_cache[instrument_url] = symbol
    
    return symbol


def prefetch_instruments(instrument_urls):
    """Prefetch all instrument URLs concurrently and cache them"""
    urls_to_fetch = []
    
    with instrument_cache_lock:
        for url in instrument_urls:
            if url not in instrument_cache:
                urls_to_fetch.append(url)
    
    if not urls_to_fetch:
        return
    
    def fetch_single_instrument(url):
        try:
            instrument_data = rh.stocks.get_instrument_by_url(url)
            return url, instrument_data['symbol']
        except Exception:
            return url, None
    
    # Fetch concurrently
    futures = {executor.submit(fetch_single_instrument, url): url for url in urls_to_fetch}
    
    for future in as_completed(futures):
        url, symbol = future.result()
        if symbol:
            with instrument_cache_lock:
                instrument_cache[url] = symbol


def process_orders_optimized(orders):
    """
    Process all orders in a single pass to extract:
    - individual_orders (transactions by symbol)
    - stock_ages (time held for each stock)
    - earliest_date (earliest purchase date)
    
    This replaces fetch_transactions(), get_stock_ages(), and get_earliest_purchase_date()
    """
    individual_orders = {}
    stock_dates = defaultdict(list)
    all_dates = []
    
    for order in orders:
        instrument_url = order['instrument']
        symbol = get_instrument_symbol(instrument_url)
        
        if symbol not in individual_orders:
            individual_orders[symbol] = [[], []]
        
        if order['state'] == 'filled':
            # Process executions for transactions
            for execution in order['executions']:
                date_str = execution['timestamp'][:execution['timestamp'].find("T")]
                amount = float(execution['rounded_notional']) * (-1 if order['side'] == 'buy' else 1)
                individual_orders[symbol][0].append(date_str)
                individual_orders[symbol][1].append(amount)
            
            # Process order date for stock ages
            try:
                order_date = datetime.strptime(order["last_transaction_at"], "%Y-%m-%dT%H:%M:%SZ")
            except:
                order_date = datetime.strptime(order["last_transaction_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
            
            stock_dates[symbol].append(order_date)
            all_dates.append(order_date)
    
    # Calculate stock ages
    stock_ages = {}
    today = datetime.today()
    
    for stock, dates in stock_dates.items():
        earliest_date = min(dates)
        diff = relativedelta(today, earliest_date)
        stock_ages[stock] = f"{diff.years} years {diff.months} months {diff.days} days"
    
    # Get earliest purchase date
    earliest_date = min(all_dates) if all_dates else datetime.today()
    
    return individual_orders, stock_ages, earliest_date


def fetch_sp500_history(start_date):
    """Fetch S&P 500 historical data once"""
    sp500 = yf.Ticker("^GSPC")
    today = datetime.today()
    hist = sp500.history(start=start_date.strftime('%Y-%m-%d'), end=today.strftime('%Y-%m-%d'))
    return hist


def fetch_asset_metadata_single(symbol, fallback_name):
    """Fetch metadata for a single symbol"""
    if symbol in asset_metadata_cache:
        return symbol, asset_metadata_cache[symbol]
    
    sector = 'Uncategorized'
    is_etf = False

    try:
        info = yf.Ticker(symbol).info or {}
        sector = (info.get('sector') or info.get('category') or sector)
        if isinstance(sector, str):
            sector = sector.strip()
        else:
            sector = 'Uncategorized'
        quote_type = (info.get('quoteType') or '').upper()
        if quote_type == 'ETF':
            is_etf = True
    except Exception:
        pass

    name_text = (fallback_name or '').lower()
    if not is_etf and any(token in name_text for token in ['etf', 'index', 'fund', 'spdr', 'ishares', 'vanguard', 'invesco']):
        is_etf = True

    metadata = {
        'sector': sector or 'Uncategorized',
        'isEtf': is_etf
    }
    
    return symbol, metadata


def fetch_asset_metadata_batch(symbols_with_names):
    """Fetch asset metadata for multiple symbols concurrently"""
    symbols_to_fetch = [(s, n) for s, n in symbols_with_names if s not in asset_metadata_cache]
    
    if not symbols_to_fetch:
        return
    
    futures = {executor.submit(fetch_asset_metadata_single, symbol, name): symbol 
               for symbol, name in symbols_to_fetch}
    
    for future in as_completed(futures):
        symbol, metadata = future.result()
        asset_metadata_cache[symbol] = metadata


def get_asset_metadata(symbol, fallback_name=''):
    """Return cached sector/ETF metadata for a symbol."""
    if symbol in asset_metadata_cache:
        return asset_metadata_cache[symbol]

    _, metadata = fetch_asset_metadata_single(symbol, fallback_name)
    asset_metadata_cache[symbol] = metadata
    return metadata


def calculate_xirr_investments(stocks_data, individual_orders):
    """Calculate XIRR and total investments"""
    today_date = datetime.today().strftime('%Y-%m-%d')
    xirr_values = []
    investments = []
    
    for item in stocks_data:
        symbol = item['Symbol']
        symbol_orders = individual_orders.get(symbol, [[], []])
        dates_for_symbol = symbol_orders[0]
        amounts_for_symbol = symbol_orders[1]

        investments.append(-1 * sum(amounts_for_symbol))
        
        # Create a copy for XIRR calculation
        dates_copy = dates_for_symbol.copy()
        amounts_copy = amounts_for_symbol.copy()
        
        dates_copy.append(today_date)
        amounts_copy.append(item['Current Value'])

        try:
            xirr_values.append(float(xirr(dates_copy, amounts_copy)))
        except Exception:
            xirr_values.append(0.0)
    
    # Calculate overall XIRR
    all_dates = []
    all_amounts = []
    
    for value in individual_orders.values():
        all_dates.extend(value[0])
        all_amounts.extend(value[1])
    
    # Add current total value
    all_dates.append(today_date)
    all_amounts.append(sum([s['Current Value'] for s in stocks_data]))

    try:
        overall_xirr = float(xirr(all_dates, all_amounts))
    except Exception:
        overall_xirr = 0.0
    
    return overall_xirr, xirr_values, investments


def calculate_sp500_comparison_optimized(start_date, total_investment, hist):
    """Calculate S&P 500 performance with SIP strategy using pre-fetched data"""
    if total_investment <= 0 or hist.empty:
        return None

    today = datetime.today()
    
    # Calculate number of months from start to today
    diff = relativedelta(today, start_date)
    total_months = diff.years * 12 + diff.months
    
    if total_months == 0:
        total_months = 1
    
    # Monthly SIP amount
    monthly_sip = total_investment / total_months
    
    # Simulate SIP purchases
    sip_dates = []
    sip_amounts = []
    current_date = start_date
    
    shares_owned = 0
    total_invested = 0
    
    while current_date <= today:
        # Find the closest trading day
        date_str = current_date.strftime('%Y-%m-%d')
        
        # Get the price for this month (use the first available price)
        month_data = hist[hist.index >= date_str]
        
        if not month_data.empty:
            price = month_data.iloc[0]['Close']
            shares_bought = monthly_sip / price
            shares_owned += shares_bought
            total_invested += monthly_sip
            
            sip_dates.append(date_str)
            sip_amounts.append(-monthly_sip)
        
        # Move to next month
        current_date += relativedelta(months=1)
    
    # Get current S&P 500 price
    current_price = hist.iloc[-1]['Close']
    current_value = shares_owned * current_price
    
    # Add final value for XIRR calculation
    sip_dates.append(today.strftime('%Y-%m-%d'))
    sip_amounts.append(current_value)
    
    # Calculate XIRR for S&P 500
    try:
        sp500_xirr = float(xirr(sip_dates, sip_amounts))
    except Exception:
        sp500_xirr = 0.0
    
    profit_loss = current_value - total_invested
    
    # Calculate time held
    diff = relativedelta(today, start_date)
    time_held = f"{diff.years} years {diff.months} months {diff.days} days"
    
    return {
        'name': 'S&P 500 Index',
        'symbol': '^GSPC',
        'quantity': shares_owned,
        'avgCost': total_invested / shares_owned if shares_owned > 0 else 0,
        'currentPrice': current_price,
        'investment': total_invested,
        'currentValue': current_value,
        'profitLoss': profit_loss,
        'xirr': sp500_xirr,
        'timeHeld': time_held
    }


def get_historical_performance_optimized(individual_orders, start_date, sp500_hist):
    """Get historical performance data for portfolio vs S&P 500 using pre-fetched data"""
    today = datetime.today()
    
    if sp500_hist.empty:
        return []
    
    # Get all transaction dates and sort them
    all_dates = []
    all_amounts = []
    
    for symbol, (dates, amounts) in individual_orders.items():
        all_dates.extend(dates)
        all_amounts.extend(amounts)
    
    # Combine dates and amounts, sort by date
    transactions = sorted(zip(all_dates, all_amounts), key=lambda x: x[0])
    
    # Calculate portfolio value over time
    historical_data = []
    current_date = start_date
    portfolio_cash_flows = {}
    
    # Build cash flow dictionary
    for date_str, amount in transactions:
        if date_str not in portfolio_cash_flows:
            portfolio_cash_flows[date_str] = 0
        portfolio_cash_flows[date_str] += amount
    
    # Calculate cumulative investment
    cumulative_investment = 0
    sp500_shares = 0
    sp500_investment = 0
    processed_transaction_dates = set()
    
    # Pre-convert sp500_hist index to strings for faster lookup
    sp500_index_strings = sp500_hist.index.strftime('%Y-%m-%d').tolist()
    sp500_prices = sp500_hist['Close'].tolist()
    
    # Sample weekly
    while current_date <= today:
        date_str = current_date.strftime('%Y-%m-%d')
        
        # Add any transactions up to this date
        for trans_date, amount in transactions:
            if trans_date <= date_str and trans_date not in processed_transaction_dates:
                cumulative_investment += abs(amount)
                processed_transaction_dates.add(trans_date)
                
                # For S&P 500, buy shares at the price on transaction date
                for i, idx_date in enumerate(sp500_index_strings):
                    if idx_date >= trans_date:
                        sp500_price = sp500_prices[i]
                        sp500_shares += abs(amount) / sp500_price
                        sp500_investment += abs(amount)
                        break
        
        # Get S&P 500 value at this date
        for i, idx_date in enumerate(sp500_index_strings):
            if idx_date >= date_str:
                if cumulative_investment > 0:
                    sp500_current_price = sp500_prices[i]
                    sp500_value = sp500_shares * sp500_current_price
                    
                    historical_data.append({
                        'date': current_date.strftime('%b %d, %Y'),
                        'portfolio': cumulative_investment,
                        'sp500': sp500_value,
                        'portfolioInvestment': cumulative_investment,
                        'sp500Investment': sp500_investment
                    })
                break
        
        current_date += timedelta(days=7)
    
    return historical_data


def get_monthly_cash_flows(individual_orders):
    """Aggregate buy/sell/net cash flows by month across all stock transactions."""
    monthly_totals = defaultdict(lambda: {
        'buy': 0.0,
        'sell': 0.0,
        'net': 0.0
    })

    for dates, amounts in individual_orders.values():
        for date_str, amount in zip(dates, amounts):
            try:
                month_key = datetime.strptime(date_str, '%Y-%m-%d').strftime('%Y-%m')
            except Exception:
                continue

            if amount < 0:
                monthly_totals[month_key]['buy'] += abs(amount)
            else:
                monthly_totals[month_key]['sell'] += amount

    results = []
    for month_key in sorted(monthly_totals.keys()):
        buy_value = monthly_totals[month_key]['buy']
        sell_value = monthly_totals[month_key]['sell']
        net_value = sell_value - buy_value

        display_month = datetime.strptime(month_key, '%Y-%m').strftime('%b %Y')
        results.append({
            'month': display_month,
            'buy': buy_value,
            'sell': sell_value,
            'net': net_value
        })

    return results


def get_cash_flow_transactions(individual_orders):
    """Flatten individual orders into date-sorted cash flow transactions.

    Amount convention:
    - Negative amount => cash outflow (buy)
    - Positive amount => cash inflow (sell)
    """
    transactions = []

    for symbol, (dates, amounts) in individual_orders.items():
        for date_str, amount in zip(dates, amounts):
            try:
                # Normalize to deterministic UTC date-only string.
                normalized_date = datetime.strptime(date_str, '%Y-%m-%d').strftime('%Y-%m-%d')
            except Exception:
                continue

            transactions.append({
                'date': normalized_date,
                'amount': float(amount),
                'symbol': symbol
            })

    transactions.sort(key=lambda row: row['date'])
    return transactions


@app.route('/api/logout', methods=['POST'])
def logout():
    global logged_in, login_token, session_start_time
    
    try:
        rh.logout()
        logged_in = False
        login_token = None
        session_start_time = None
        # delete_pickle_file()  # Delete the pickle file on logout
        
        return jsonify({
            'success': True,
            'message': 'Logged out successfully'
        })
    except Exception as e:
        # Even if logout fails, clear local state and delete pickle
        logged_in = False
        login_token = None
        session_start_time = None
        # delete_pickle_file()
        
        return jsonify({
            'success': True,
            'message': 'Logged out successfully'
        })


if __name__ == '__main__':
    print("=" * 60)
    print("🚀 Robinhood Portfolio Tracker Server Starting...")
    print("=" * 60)
    print(f"\n📊 Dashboard available at: http://localhost:5005")
    print(f"🔧 API endpoint: http://localhost:5005/api")
    print(f"\n💡 Make sure 'index.html' is in the same directory as this script")
    print(f"\n⚠️  Press Ctrl+C to stop the server\n")
    print("=" * 60 + "\n")
    
    app.run(debug=True, port=5005, host='0.0.0.0')