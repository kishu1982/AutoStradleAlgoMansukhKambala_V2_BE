// AutoStradleStrategy API Usage Examples

// ============================================
// 1. CREATE a new AutoStradleStrategy
// ============================================
POST http://localhost:3000/strategy/auto-stradle

Request Body:
{
  "strategyName": "StradleTrades",
  "tokenNumber": "48236",
  "exchange": "NFO",
  "symbolName": "NIFTY17FEB26C26000",
  "quantityLots": 1,
  "side": "SELL",
  "productType": "INTRADAY",
  "legs": 2,
  "legsData": [
    {
      "exch": "NFO",
      "instrument": "OPTIDX",
      "optionType": "CE",
      "expiry": "17-FEB-2026",
      "side": "SELL"
    },
    {
      "exch": "NFO",
      "instrument": "OPTIDX",
      "optionType": "PE",
      "expiry": "17-FEB-2026",
      "side": "SELL"
    }
  ],
  "amountForLotCalEachLeg": 25000,
  "profitBookingPercentage": 10,
  "stoplossBookingPercentage": 10,
  "otmDifference": 0.25,
  "status": "ACTIVE"
}

Response (201):
{
  "_id": "60d5ec49f1b2c72b8f8e8e8e",
  "strategyName": "StradleTrades",
  "tokenNumber": "48236",
  "exchange": "NFO",
  "symbolName": "NIFTY17FEB26C26000",
  "quantityLots": 1,
  "side": "SELL",
  "productType": "INTRADAY",
  "legs": 2,
  "legsData": [
    {
      "exch": "NFO",
      "instrument": "OPTIDX",
      "optionType": "CE",
      "expiry": "17-FEB-2026",
      "side": "SELL"
    },
    {
      "exch": "NFO",
      "instrument": "OPTIDX",
      "optionType": "PE",
      "expiry": "17-FEB-2026",
      "side": "SELL"
    }
  ],
  "amountForLotCalEachLeg": 25000,
  "profitBookingPercentage": 10,
  "stoplossBookingPercentage": 10,
  "otmDifference": 0.25,
  "status": "ACTIVE",
  "createdAt": "2026-02-11T10:00:00.000Z",
  "updatedAt": "2026-02-11T10:00:00.000Z"
}

// ============================================
// 2. GET ALL AutoStradleStrategy configs
// ============================================
GET http://localhost:3000/strategy/auto-stradle

Response (200):
[
  {
    "_id": "60d5ec49f1b2c72b8f8e8e8e",
    "strategyName": "StradleTrades",
    "tokenNumber": "48236",
    ...
  },
  {
    "_id": "60d5ec49f1b2c72b8f8e8f8f",
    "strategyName": "StradleTrades",
    "tokenNumber": "2475",
    ...
  }
]

// ============================================
// 3. GET ACTIVE AutoStradleStrategy configs
// ============================================
GET http://localhost:3000/strategy/auto-stradle/active

Response (200):
[
  {
    "_id": "60d5ec49f1b2c72b8f8e8e8e",
    "status": "ACTIVE",
    ...
  }
]

// ============================================
// 4. GET BY ID
// ============================================
GET http://localhost:3000/strategy/auto-stradle/60d5ec49f1b2c72b8f8e8e8e

Response (200):
{
  "_id": "60d5ec49f1b2c72b8f8e8e8e",
  "strategyName": "StradleTrades",
  "tokenNumber": "48236",
  ...
}

// ============================================
// 5. UPDATE by ID
// ============================================
PUT http://localhost:3000/strategy/auto-stradle/60d5ec49f1b2c72b8f8e8e8e

Request Body:
{
  "strategyName": "StradleTrades",
  "tokenNumber": "48236",
  "exchange": "NFO",
  "symbolName": "NIFTY17FEB26C26000",
  "quantityLots": 2,  // Updated
  "side": "SELL",
  "productType": "INTRADAY",
  "legs": 2,
  "legsData": [...],
  "amountForLotCalEachLeg": 30000,  // Updated
  "profitBookingPercentage": 15,    // Updated
  "stoplossBookingPercentage": 12,  // Updated
  "otmDifference": 0.25,
  "status": "ACTIVE"
}

Response (200):
{
  "_id": "60d5ec49f1b2c72b8f8e8e8e",
  "quantityLots": 2,
  "updatedAt": "2026-02-11T11:00:00.000Z",
  ...
}

// ============================================
// 6. DELETE by ID
// ============================================
DELETE http://localhost:3000/strategy/auto-stradle/60d5ec49f1b2c72b8f8e8e8e

Response (200):
{
  "message": "AutoStradleStrategy configuration deleted successfully",
  "deletedId": "60d5ec49f1b2c72b8f8e8e8e"
}

// ============================================
// ERROR RESPONSES
// ============================================

// 1. Duplicate main signal (unique constraint violation)
POST http://localhost:3000/strategy/auto-stradle
{
  "tokenNumber": "48236",  // Already exists for this exchange + symbolName + side
  "exchange": "NFO",
  "symbolName": "NIFTY17FEB26C26000",
  "side": "SELL",
  ...
}

Response (400):
{
  "statusCode": 400,
  "message": "AutoStradleStrategy configuration already exists for tokenNumber: 48236, exchange: NFO, symbolName: NIFTY17FEB26C26000, side: SELL",
  "error": "Bad Request"
}

// 2. Legs count mismatch
POST http://localhost:3000/strategy/auto-stradle
{
  ...
  "legs": 2,
  "legsData": [
    { "exch": "NFO", "instrument": "OPTIDX", "optionType": "CE", "expiry": "17-FEB-2026", "side": "SELL" }
    // Only 1 leg provided but legs count is 2
  ],
  ...
}

Response (400):
{
  "statusCode": 400,
  "message": "Invalid legs configuration. Expected 2 legs, but received 1. The legsData array length must match the legs count.",
  "error": "Bad Request"
}

// 3. Missing mandatory fields
POST http://localhost:3000/strategy/auto-stradle
{
  "strategyName": "StradleTrades",
  "tokenNumber": "48236"
  // Missing required fields
}

Response (400):
{
  "statusCode": 400,
  "message": "Validation failed",
  "errors": [
    "exchange should not be empty",
    "symbolName should not be empty",
    "side must be one of BUY, SELL, EXIT",
    ...
  ]
}

// 4. Invalid enum value
POST http://localhost:3000/strategy/auto-stradle
{
  ...
  "side": "HOLD",  // Invalid, must be BUY, SELL, or EXIT
  ...
}

Response (400):
{
  "statusCode": 400,
  "message": "Validation failed",
  "errors": [
    "side must be one of BUY, SELL, EXIT"
  ]
}

// 5. Invalid ID format
GET http://localhost:3000/strategy/auto-stradle/invalid-id-format

Response (400):
{
  "statusCode": 400,
  "message": "Invalid ID format: invalid-id-format",
  "error": "Bad Request"
}

// 6. ID not found
GET http://localhost:3000/strategy/auto-stradle/60d5ec49f1b2c72b8f8e8999

Response (404):
{
  "statusCode": 404,
  "message": "AutoStradleStrategy configuration not found with ID: 60d5ec49f1b2c72b8f8e8999",
  "error": "Not Found"
}

// ============================================
// VALIDATION RULES
// ============================================

strategyName: string (required, non-empty)
tokenNumber: string (required, non-empty)
exchange: string (required, non-empty)
symbolName: string (required, non-empty)
quantityLots: number (required, min: 1)
side: enum (required) - BUY, SELL, EXIT
productType: enum (required) - INTRADAY, NORMAL, DELIVERY
legs: number (required, min: 1)
legsData: array of AutoStradleLegDto objects (required)
  - exch: enum (required) - NSE, NFO, BSE, BFO
  - instrument: enum (required) - FUTIDX, OPTIDX
  - optionType: enum (required) - PE, CE
  - expiry: string (required, format: DD-MMM-YYYY e.g., 17-FEB-2026)
  - side: enum (required) - BUY, SELL, EXIT
amountForLotCalEachLeg: number (required, min: 0)
profitBookingPercentage: number (required, min: 0)
stoplossBookingPercentage: number (required, min: 0)
otmDifference: number (required, min: 0)
status: enum (optional) - ACTIVE, INACTIVE

// ============================================
// UNIQUE CONSTRAINT
// ============================================

The combination of (tokenNumber, exchange, symbolName, side) must be UNIQUE.
You cannot have two configurations with the same values for all four fields.

Example: These would be considered duplicates:
- tokenNumber: "48236", exchange: "NFO", symbolName: "NIFTY17FEB26C26000", side: "SELL"
- tokenNumber: "48236", exchange: "NFO", symbolName: "NIFTY17FEB26C26000", side: "SELL"

But these are different:
- tokenNumber: "48236", exchange: "NFO", symbolName: "NIFTY17FEB26C26000", side: "SELL"
- tokenNumber: "48236", exchange: "NFO", symbolName: "NIFTY17FEB26C26000", side: "BUY"  ✓ (different side)
- tokenNumber: "2475", exchange: "NFO", symbolName: "NIFTY17FEB26C26000", side: "SELL"    ✓ (different token)
