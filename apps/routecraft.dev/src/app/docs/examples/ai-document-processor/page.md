---
title: Travel & Booking Assistant
---

Automate travel planning and booking with AI. {% .lead %}

{% callout type="note" %}
This example demonstrates the intended API design for complex multi-step automation. Some integrations may require API keys from booking services.
{% /callout %}

```ts
import { mcp } from '@routecraft/ai'
import { craft, noop } from '@routecraft/routecraft'
import { z } from 'zod'

// Tool 1: Search flights
craft()
  .id('search-flights')
  .from(mcp('search-flights', {
    description: 'Search for available flights',
    schema: z.object({
      from: z.string().describe('Departure airport code'),
      to: z.string().describe('Destination airport code'),
      date: z.string().describe('Travel date YYYY-MM-DD'),
      passengers: z.number().default(1)
    }),
    keywords: ['flight', 'travel', 'booking', 'airline']
  }))
  .process(async (req) => {
    const flights = await searchFlightAPI({
      origin: req.from,
      destination: req.to,
      date: req.date,
      passengers: req.passengers
    })
    return {
      flights: flights.slice(0, 5).map(f => ({
        airline: f.airline,
        flightNumber: f.number,
        departure: f.departureTime,
        arrival: f.arrivalTime,
        price: f.price,
        duration: f.duration
      }))
    }
  })
  .to(noop())

// Tool 2: Book restaurant
craft()
  .id('book-restaurant')
  .from(mcp('book-restaurant', {
    description: 'Find and book a restaurant reservation',
    schema: z.object({
      cuisine: z.string(),
      city: z.string(),
      date: z.string(),
      time: z.string(),
      partySize: z.number()
    }),
    keywords: ['restaurant', 'dining', 'reservation', 'food']
  }))
  .process(async (req) => {
    // Search OpenTable or similar
    const restaurants = await searchRestaurants({
      location: req.city,
      cuisine: req.cuisine,
      date: req.date,
      time: req.time,
      partySize: req.partySize
    })
    
    // Book the best match
    const booking = await bookTable(restaurants[0].id, {
      date: req.date,
      time: req.time,
      partySize: req.partySize
    })
    
    return {
      restaurant: restaurants[0].name,
      address: restaurants[0].address,
      time: booking.time,
      confirmationCode: booking.code
    }
  })
  .to(noop())

// Tool 3: Hotel search
craft()
  .id('search-hotels')
  .from(mcp('search-hotels', {
    description: 'Search for hotels in a city',
    schema: z.object({
      city: z.string(),
      checkIn: z.string(),
      checkOut: z.string(),
      guests: z.number().default(1),
      maxPrice: z.number().optional()
    }),
    keywords: ['hotel', 'accommodation', 'booking', 'lodging']
  }))
  .process(async (req) => {
    const hotels = await searchHotels(req)
    return {
      hotels: hotels.slice(0, 5).map(h => ({
        name: h.name,
        rating: h.rating,
        pricePerNight: h.price,
        amenities: h.amenities,
        availability: h.available
      }))
    }
  })
  .to(noop())
```

## Usage Examples

**User:** "Find me flights from NYC to London on March 15th"

**Claude:** (Searches flights, presents options with prices and times)

**User:** "Book a table for 4 at an Italian restaurant in San Francisco tomorrow at 7pm"

**Claude:** (Searches restaurants, books reservation, confirms details)

**User:** "I need a hotel in Tokyo from June 1-5, budget under $200/night"

**Claude:** (Searches hotels, filters by price, shows available options)

## Multi-Step Travel Planning

AI can chain these tools together:

**User:** "Plan a weekend trip to Miami - find flights, book a hotel, and make a dinner reservation"

**Claude:**
1. Searches flights for weekend dates
2. Searches hotels near airport/downtown
3. Books restaurant for Saturday evening
4. Presents complete itinerary with confirmation codes

## Security & Control

- AI can only search and book through approved APIs
- No credit card access (you control payment separately)
- All bookings logged and auditable
- Rate limiting to prevent excessive API calls
- Confirmation codes returned for verification

## API Integrations

### Flight APIs
- Amadeus Flight Search API
- Skyscanner API
- Kayak API

### Restaurant Booking
- OpenTable API
- Resy API
- Google Places API

### Hotel Booking
- Booking.com API
- Expedia API
- Airbnb API (for rentals)

## Use Cases

- Quick flight searches while traveling
- Last-minute dinner reservations
- Complete trip planning from one conversation
- Hotel comparisons across dates
- Group travel coordination
