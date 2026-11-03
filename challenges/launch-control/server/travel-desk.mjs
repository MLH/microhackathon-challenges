/**
 * The travel desk: the three tools the booker can call, run against the package's made-up
 * `inventory.json`. Searches read only that file, and `book_trip` writes its fake itinerary only to
 * the one workspace path it is given. There are no real travel APIs, payments, or personal data.
 * Every tool answers with a plain object the model reads; a bad call answers `{ error }` so the
 * model can correct itself.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeWorkspaceFile } from './workspace-file.mjs';

/** The package file holding the inventory. */
export const INVENTORY_FILE_NAME = 'inventory.json';

/** A date the tools accept: `YYYY-MM-DD`. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds in a day, for counting hotel nights. */
const DAY_MS = 86_400_000;

/** Read the package's inventory. */
export function loadInventory(packageDir) {
  return JSON.parse(readFileSync(path.join(packageDir, INVENTORY_FILE_NAME), 'utf8'));
}

/**
 * Parse a `YYYY-MM-DD` date.
 *
 * @returns {{ year: string, monthDay: string, time: number } | null} `null` when it is not a real
 *   calendar date in that form.
 */
function parseDate(value) {
  const match = DATE_PATTERN.exec(String(value ?? ''));
  if (match === null) {
    return null;
  }
  const [, year, month, day] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (new Date(time).getUTCDate() !== Number(day)) {
    return null;
  }

  return { year, monthDay: `${month}-${day}`, time };
}

/** A flight as a tool result, dated in the year the caller asked about. */
function presentFlight(flight, year) {
  const { date, ...rest } = flight;

  return { ...rest, date: `${year}-${date}` };
}

/** Runs the booker's tool calls against the inventory. */
export class TravelDesk {
  /** @param {{ inventory: object, itineraryFile: string }} options */
  constructor(options) {
    this.inventory = options.inventory;
    this.itineraryFile = options.itineraryFile;
  }

  /**
   * Run one tool call.
   *
   * @returns {Promise<object>} the tool's answer, or `{ error }` for a bad call or an unknown tool.
   */
  async run(name, args) {
    switch (name) {
      case 'search_flights':
        return this.searchFlights(args ?? {});
      case 'search_hotels':
        return this.searchHotels(args ?? {});
      case 'book_trip':
        return this.bookTrip(args ?? {});
      default:
        return { error: `There is no tool named ${name}.` };
    }
  }

  /** One-way flights between two airports on one date. */
  searchFlights({ origin, destination, date }) {
    const day = parseDate(date);
    if (day === null) {
      return { error: 'date must be YYYY-MM-DD.' };
    }
    const from = String(origin ?? '').toUpperCase();
    const to = String(destination ?? '').toUpperCase();

    const flights = this.inventory.flights
      .filter((flight) => flight.origin === from && flight.destination === to && flight.date === day.monthDay)
      .map((flight) => presentFlight(flight, day.year));
    if (flights.length === 0) {
      return { flights, note: `No flights from ${from} to ${to} on ${date}.` };
    }

    return { flights };
  }

  /** Hotels in one city, with nightly prices, for a stay between two dates. */
  searchHotels({ city, check_in: checkIn, check_out: checkOut }) {
    const arrival = parseDate(checkIn);
    const departure = parseDate(checkOut);
    if (arrival === null || departure === null || departure.time <= arrival.time) {
      return { error: 'check_in and check_out must be YYYY-MM-DD, with check_out after check_in.' };
    }

    const wanted = String(city ?? '').trim().toLowerCase();
    const hotels = this.inventory.hotels
      .filter((hotel) => hotel.city.toLowerCase() === wanted)
      .map(({ id, name, neighborhood, waterfront, nightly_usd }) => ({ id, name, neighborhood, waterfront, nightly_usd }));
    if (hotels.length === 0) {
      return { hotels, note: `No hotels in ${city}.` };
    }

    return { hotels };
  }

  /**
   * Book a round trip and a hotel, checking that the pieces fit together, and write the itinerary.
   *
   * @returns {Promise<object>} the confirmation with its total, or `{ error }` naming what does
   *   not fit.
   */
  async bookTrip(args) {
    const outbound = this.inventory.flights.find((flight) => flight.id === args.outbound_flight_id);
    const inbound = this.inventory.flights.find((flight) => flight.id === args.return_flight_id);
    const hotel = this.inventory.hotels.find((candidate) => candidate.id === args.hotel_id);
    const arrival = parseDate(args.check_in);
    const departure = parseDate(args.check_out);

    const problem = this.#bookingProblem({ outbound, inbound, hotel, arrival, departure, args });
    if (problem !== null) {
      return { error: problem };
    }

    const nights = Math.round((departure.time - arrival.time) / DAY_MS);
    const hotelTotal = hotel.nightly_usd * nights;
    const itinerary = {
      confirmation: `LC-${randomBytes(3).toString('hex').toUpperCase()}`,
      outbound: presentFlight(outbound, arrival.year),
      return: presentFlight(inbound, departure.year),
      hotel: { id: hotel.id, name: hotel.name, neighborhood: hotel.neighborhood, waterfront: hotel.waterfront },
      check_in: args.check_in,
      check_out: args.check_out,
      nights,
      hotel_total_usd: hotelTotal,
      total_usd: outbound.price_usd + inbound.price_usd + hotelTotal,
      note: 'A made-up booking from the Launch Control travel desk. Nothing was charged.',
    };
    await writeWorkspaceFile(this.itineraryFile, `${JSON.stringify(itinerary, null, 2)}\n`);

    return itinerary;
  }

  /** What is wrong with a booking request, or `null` when it fits together. */
  #bookingProblem({ outbound, inbound, hotel, arrival, departure, args }) {
    if (outbound === undefined || inbound === undefined || hotel === undefined) {
      return 'Unknown flight or hotel id. Use ids from search_flights and search_hotels.';
    }
    if (arrival === null || departure === null || departure.time <= arrival.time) {
      return 'check_in and check_out must be YYYY-MM-DD, with check_out after check_in.';
    }
    if (inbound.origin !== outbound.destination || inbound.destination !== outbound.origin) {
      return 'The return flight must fly back from where the outbound flight lands.';
    }
    if (this.inventory.airports[outbound.destination] !== hotel.city) {
      return `The hotel must be in ${this.inventory.airports[outbound.destination]}.`;
    }
    if (outbound.date !== arrival.monthDay || inbound.date !== departure.monthDay) {
      return `The outbound flight must leave on check_in (${args.check_in}) and the return flight on check_out (${args.check_out}).`;
    }

    return null;
  }
}
