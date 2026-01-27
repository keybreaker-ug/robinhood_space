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

app = Flask(__name__, static_folder='.')
CORS(app)  # Enable CORS for local development

# Global variable to store login state
logged_in = False
login_token = None

@app.route('/')
def serve_index():
    """Serve the index.html file"""
    return send_from_directory('.', 'index.html')

@app.route('/api/login', methods=['POST'])
def login():
    global logged_in, login_token
    
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    try:
        # Login to Robinhood
        login_result = rh.login(username, password)
        
        if login_result:
            logged_in = True
            login_token = login_result
            return jsonify({
                'success': True,
                'message': 'Login successful',
                'requires_2fa': False
            })
        else:
            return jsonify({
                'success': False,
                'message': 'Login failed'
            }), 401
            
    except Exception as e:
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500

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
        
        # Fetch transactions
        individual_orders = fetch_transactions()
        
        # Calculate XIRR and Investments
        overall_xirr, xirr_values, investments = calculate_xirr_investments(stocks_data, individual_orders)
        
        # Get stock ages
        stock_ages = get_stock_ages()
        
        # Get earliest purchase date across all stocks
        earliest_date = get_earliest_purchase_date()
        
        # Calculate S&P 500 comparison
        sp500_data = calculate_sp500_comparison(earliest_date, sum(investments))
        
        # Get historical performance data
        historical_data = get_historical_performance(individual_orders, earliest_date)
        
        # Combine all data
        portfolio_stocks = []
        for stock, xirr_value, investment in zip(stocks_data, xirr_values, investments):
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
                'timeHeld': stock_ages.get(stock['Symbol'], 'N/A')
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

def fetch_transactions():
    """Fetch all stock transactions from Robinhood"""
    orders = rh.orders.get_all_stock_orders()
    orders = orders[::-1]
    
    individual_orders = {}
    
    for order in orders:
        instrument = order['instrument']
        instrument_data = rh.stocks.get_instrument_by_url(instrument)
        symbol = instrument_data['symbol']
        
        if symbol not in individual_orders:
            individual_orders[symbol] = [[], []]
        
        if order['state'] == 'filled':
            for execution in order['executions']:
                individual_orders[symbol][0].append(execution['timestamp'][:execution['timestamp'].find("T")])
                individual_orders[symbol][1].append(float(execution['rounded_notional']) * (-1 if order['side'] == 'buy' else 1))
    
    return individual_orders

def get_stock_ages():
    """Fetch earliest order date and account age for each individual stock"""
    orders = rh.orders.get_all_stock_orders()
    stock_dates = defaultdict(list)
    
    for order in orders:
        if order["state"] == "filled":
            instrument = order['instrument']
            instrument_data = rh.stocks.get_instrument_by_url(instrument)
            symbol = instrument_data['symbol']
            try:
                order_date = datetime.strptime(order["last_transaction_at"], "%Y-%m-%dT%H:%M:%SZ")
            except:
                order_date = datetime.strptime(order["last_transaction_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
            stock_dates[symbol].append(order_date)
    
    stock_ages = {}
    today = datetime.today()
    
    for stock, dates in stock_dates.items():
        earliest_date = min(dates)
        diff = relativedelta(today, earliest_date)
        stock_ages[stock] = f"{diff.years} years {diff.months} months {diff.days} days"
    
    return stock_ages

def get_earliest_purchase_date():
    """Get the earliest purchase date across all stocks"""
    orders = rh.orders.get_all_stock_orders()
    all_dates = []
    
    for order in orders:
        if order["state"] == "filled":
            try:
                order_date = datetime.strptime(order["last_transaction_at"], "%Y-%m-%dT%H:%M:%SZ")
            except:
                order_date = datetime.strptime(order["last_transaction_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
            all_dates.append(order_date)
    
    return min(all_dates) if all_dates else datetime.today()

def calculate_xirr_investments(stocks_data, individual_orders):
    """Calculate XIRR and total investments"""
    today_date = datetime.today().strftime('%Y-%m-%d')
    xirr_values = []
    investments = []
    
    for item in stocks_data:
        symbol = item['Symbol']
        investments.append(-1 * sum(individual_orders[symbol][1]))
        
        # Create a copy for XIRR calculation
        dates_copy = individual_orders[symbol][0].copy()
        amounts_copy = individual_orders[symbol][1].copy()
        
        dates_copy.append(today_date)
        amounts_copy.append(item['Current Value'])
        
        xirr_values.append(xirr(dates_copy, amounts_copy))
    
    # Calculate overall XIRR
    all_dates = []
    all_amounts = []
    
    for value in individual_orders.values():
        all_dates.extend(value[0])
        all_amounts.extend(value[1])
    
    # Add current total value
    all_dates.append(today_date)
    all_amounts.append(sum([s['Current Value'] for s in stocks_data]))
    
    overall_xirr = xirr(sorted(zip(all_dates, all_amounts)))
    
    return overall_xirr, xirr_values, investments

def calculate_sp500_comparison(start_date, total_investment):
    """Calculate S&P 500 performance with SIP strategy"""
    # Download S&P 500 data
    sp500 = yf.Ticker("^GSPC")
    
    today = datetime.today()
    hist = sp500.history(start=start_date.strftime('%Y-%m-%d'), end=today.strftime('%Y-%m-%d'))
    
    if hist.empty:
        return None
    
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
    sp500_xirr = xirr(sip_dates, sip_amounts)
    
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

def get_historical_performance(individual_orders, start_date):
    """Get historical performance data for portfolio vs S&P 500"""
    today = datetime.today()
    
    # Download S&P 500 historical data
    sp500 = yf.Ticker("^GSPC")
    sp500_hist = sp500.history(start=start_date.strftime('%Y-%m-%d'), end=today.strftime('%Y-%m-%d'))
    
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
    
    # Sample weekly
    while current_date <= today:
        date_str = current_date.strftime('%Y-%m-%d')
        
        # Add any transactions up to this date
        for trans_date, amount in transactions:
            if trans_date <= date_str and trans_date not in [d for d, _ in historical_data]:
                cumulative_investment += abs(amount)
                
                # For S&P 500, buy shares at the price on transaction date
                closest_sp500_date = sp500_hist.index[sp500_hist.index >= trans_date]
                if len(closest_sp500_date) > 0:
                    sp500_price = sp500_hist.loc[closest_sp500_date[0]]['Close']
                    sp500_shares += abs(amount) / sp500_price
                    sp500_investment += abs(amount)
        
        # Get S&P 500 value at this date
        closest_date = sp500_hist.index[sp500_hist.index >= date_str]
        if len(closest_date) > 0 and cumulative_investment > 0:
            sp500_current_price = sp500_hist.loc[closest_date[0]]['Close']
            sp500_value = sp500_shares * sp500_current_price
            
            # Normalize to percentage gain
            portfolio_gain_pct = 0  # Placeholder - actual portfolio value would need real-time calculation
            sp500_gain_pct = ((sp500_value - sp500_investment) / sp500_investment * 100) if sp500_investment > 0 else 0
            
            historical_data.append({
                'date': current_date.strftime('%b %d, %Y'),
                'portfolio': cumulative_investment,  # Simplified - would need actual portfolio value
                'sp500': sp500_value,
                'portfolioInvestment': cumulative_investment,
                'sp500Investment': sp500_investment
            })
        
        current_date += timedelta(days=7)
    
    return historical_data

@app.route('/api/logout', methods=['POST'])
def logout():
    global logged_in, login_token
    
    try:
        rh.logout()
        logged_in = False
        login_token = None
        
        return jsonify({
            'success': True,
            'message': 'Logged out successfully'
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500

if __name__ == '__main__':
    print("=" * 60)
    print("🚀 Robinhood Portfolio Tracker Server Starting...")
    print("=" * 60)
    print(f"\n📊 Dashboard available at: http://localhost:5000")
    print(f"🔧 API endpoint: http://localhost:5000/api")
    print(f"\n💡 Make sure 'index.html' is in the same directory as this script")
    print(f"\n⚠️  Press Ctrl+C to stop the server\n")
    print("=" * 60 + "\n")
    
    app.run(debug=True, port=5000, host='0.0.0.0')