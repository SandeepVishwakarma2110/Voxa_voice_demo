

// import { tool } from "@langchain/core/tools";
// import { z } from "zod";
// import { google } from "googleapis";
// import * as chrono from "chrono-node";
// import "dotenv/config";
// import { config } from '../config/index.js';

// // --- CONFIGURATION ---
// const CALENDAR_ID = config.calendar.calendarId;
// const SCOPES = ["https://www.googleapis.com/auth/calendar"];
// const TIMEZONE = "Asia/Kolkata";
// const SLOT_DURATION = 30; // 30 minutes slots

// // --- AUTHENTICATION & TRANSPORTER ---
// const auth = new google.auth.GoogleAuth({
//   keyFile: "./service-account.json",
//   scopes: SCOPES,
// });
// const calendar = google.calendar({ version: "v3", auth });

// const normalizeDate = (inputDate) => {
//   // 1. Get the current time specifically in Asia/Kolkata
//   const nowInIndia = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  
//   // 2. Use 'nowInIndia' as the reference for relative dates like "upcoming friday"
//   const parsedDate = chrono.parseDate(inputDate, nowInIndia, { forwardDate: true });

//   if (!parsedDate) {
//     const directDate = new Date(inputDate);
//     if (!isNaN(directDate.getTime())) return directDate.toISOString().split('T')[0];
//     throw new Error(`Could not understand date: "${inputDate}"`);
//   }

//   // 3. Ensure we don't accidentally jump to the next year prematurely
//   const oneYearFromNow = new Date(nowInIndia);
//   oneYearFromNow.setFullYear(nowInIndia.getFullYear() + 1);

//   if (parsedDate > oneYearFromNow) {
//      parsedDate.setFullYear(nowInIndia.getFullYear());
//   }

//   const year = parsedDate.getFullYear();
//   const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
//   const day = String(parsedDate.getDate()).padStart(2, '0');
  
//   const finalDate = `${year}-${month}-${day}`;
//   console.log(`[DEBUG] Input: "${inputDate}" -> Normalized to: ${finalDate}`);
//   return finalDate;
// };


// // --- ERRORS ---
// // One concise log line instead of the whole GaxiosError (80+ lines, request
// // config included), and a message the MODEL can act on. A raw
// // "Error: invalid_grant: Invalid JWT Signature" left the agent guessing what to
// // tell the caller — and free to invent available slots.
// let authFailureLogged = false;

// function calendarFailure(error, action) {
//   const status = error.code ?? error.response?.status;
//   const detail =
//     error.response?.data?.error_description ??
//     error.response?.data?.error?.message ??
//     error.message;
//   const isAuth = /invalid_grant|invalid_client|unauthorized_client|JWT/i.test(detail) || status === 401;

//   if (isAuth) {
//     if (!authFailureLogged) {
//       authFailureLogged = true;
//       console.error(
//         `❌ [CALENDAR] Google rejected the service account: ${detail}\n` +
//         `   Diagnose with:  node scripts/check-google-auth.js`
//       );
//     } else {
//       console.error(`❌ [CALENDAR] ${action}: auth still failing (${detail})`);
//     }
//     return (
//       'CALENDAR_UNAVAILABLE: the calendar system cannot be reached right now. ' +
//       'Tell the caller you cannot check or book the calendar at the moment, and that ' +
//       'our team will call them back on this number to schedule the meeting. ' +
//       'Do NOT offer, suggest or invent any times.'
//     );
//   }

//   console.error(`❌ [CALENDAR] ${action} failed (${status ?? 'no status'}): ${detail}`);
//   if (status === 404) return 'Error: Calendar ID not found. Check CALENDAR_ID in .env';
//   if (status === 403) return 'Error: Service account does not have permission to write to this calendar.';
//   return (
//     `CALENDAR_ERROR: ${action} failed (${detail}). Tell the caller there was a problem ` +
//     'with the calendar and offer to try again. Do NOT invent any times.'
//   );
// }

// // --- TOOL 1: CHECK AVAILABILITY ---
// export const checkAvailabilityTool = tool(
//   async ({ date }) => {
//     try {
//       process.stdout.write(`\n>>> STARTING CALENDAR AVAILABILITY TOOL FOR DATE: ${date} <<<\n`);
//       const formattedDate = normalizeDate(date);
//       console.log(`[TOOL] Checking 30-min slots for ${formattedDate}...`);
 
//       const timeMin = new Date(`${formattedDate}T00:00:00Z`).toISOString();
//       const timeMax = new Date(`${formattedDate}T23:59:59Z`).toISOString();

//       const response = await calendar.events.list({
//         calendarId: CALENDAR_ID,
//         timeMin: timeMin,
//         timeMax: timeMax,
//         singleEvents: true,
//         orderBy: "startTime",
//       });

//       process.stdout.write(`✅ Found ${response.data.items.length} events for this day.\n`);
//       const events = response.data.items;
//       const busyTimes = events.map(event => ({
//         start: new Date(event.start.dateTime || event.start.date),
//         end: new Date(event.end.dateTime || event.end.date)
//       }));

//       const availableSlots = [];
//       let currentSlot = new Date(`${formattedDate}T09:00:00`);
//       const endOfDay = new Date(`${formattedDate}T17:00:00`);

//       while (currentSlot < endOfDay) {
//         const slotEnd = new Date(currentSlot.getTime() + SLOT_DURATION * 60 * 1000);
//         const isBusy = busyTimes.some(busy => (currentSlot < busy.end && slotEnd > busy.start));

//         if (!isBusy) {
//           availableSlots.push(
//             currentSlot.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
//           );
//         }
//         currentSlot = slotEnd;
//       }

//       return availableSlots.length === 0
//         ? "No slots available for this date."
//         : `Available slots on ${formattedDate}: ${availableSlots.join(", ")}`;

//     } catch (error) {
//       if (/Could not understand date/.test(error.message)) {
//         return `Error: ${error.message}. Ask the caller for the date again.`;
//       }
//       return calendarFailure(error, 'check availability');
//     }
//   },
//   {
//     name: "check_availability",
//     description: "Check available 30-minute time slots for a specific date; you can check any date in the future.",
//     schema: z.object({ 
//         date: z.string().describe("Date like 'tomorrow' or '2026-05-20'; Date in YYYY-MM-DD format.") 
//     }),
//   }
// );

// // --- TOOL 2: BOOK APPOINTMENT ---
// /** "14:30" -> "02:30 PM". The reverse of the parsing above, so what we report
//  *  back is the slot the calendar actually holds. */
// function to12Hour(hhmm) {
//   const [h, m] = String(hhmm).split(':').map(Number);
//   if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
//   const period = h >= 12 ? 'PM' : 'AM';
//   const hour12 = h % 12 === 0 ? 12 : h % 12;
//   return `${String(hour12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
// }

// export const bookAppointmentTool = tool(
//   async ({ date, time, email, name }) => {
//     const DURATION_MINUTES = 30;

//     try {
//       process.stdout.write(`\n>>> STARTING CALENDAR BOOKING TOOL FOR: ${name} <<<\n`);
//       const formattedDate = normalizeDate(date);
//       let cleanTime = time.trim().toUpperCase();

//       // 1. Convert "11:00 AM" or "2:30 PM" to 24-hour "HH:mm"
//       if (cleanTime.includes("PM") || cleanTime.includes("AM")) {
//         const [timePart, modifier] = cleanTime.split(" ");
//         let [hours, minutes] = timePart.split(":");

//         if (hours === "12") hours = "00";
//         if (modifier === "PM") hours = parseInt(hours, 10) + 12;

//         cleanTime = `${String(hours).padStart(2, '0')}:${minutes}`;
//       }

//       const startDateTime = `${formattedDate}T${cleanTime}:00`;
//       const startDate = new Date(startDateTime);

//       if (isNaN(startDate.getTime())) {
//         throw new Error(`Invalid time calculation. Resulted in: ${startDateTime}`);
//       }

//       const endDate = new Date(startDate.getTime() + DURATION_MINUTES * 60 * 1000);

//       console.log(`[CALENDAR] Attempting booking for ${name} (${email}) at ${startDateTime}`);

//       const response = await calendar.events.insert({
//         calendarId: CALENDAR_ID,
//         resource: {
//           summary: `Xverse Meeting: ${name || email}`,
//           description: `Booked via Xverse AI Assistant. Contact: ${email}`,
//           start: {
//             dateTime: startDate.toISOString(),
//             timeZone: TIMEZONE
//           },
//           end: {
//             dateTime: endDate.toISOString(),
//             timeZone: TIMEZONE
//           },
//           reminders: {
//             useDefault: true
//           }
//         },
//       });
      
//       console.log(`✅ [CALENDAR] Success! Event ID: ${response.data.id}`);

//       // Emit the date and time that were ACTUALLY booked, in a form the agent
//       // node can parse. On a live call the caller asked for 12:00, that slot
//       // was unavailable, the model proposed 11:30 and the caller agreed — but
//       // it never re-ran the extraction, so the CRM kept 12:00 while the
//       // calendar held 11:30. The calendar is the source of truth; this marker
//       // is how it gets back into leadData instead of relying on the model
//       // choosing to correct itself.
//       const bookedTime = to12Hour(cleanTime);
//       // name and email too: the model often passes them straight to this tool
//       // without extracting them first, and then they were never saved — a
//       // booked meeting whose contact email was null in the CRM.
//       const booked = JSON.stringify({
//         date: formattedDate,
//         time: bookedTime,
//         eventId: response.data.id,
//         name,
//         email,
//       });

//       return `SUCCESS: Calendar event created for ${formattedDate} at ${bookedTime}. ` +
//         `ID: ${response.data.id}. [[BOOKED:${booked}]] ` +
//         `You must now call the email tool to send the formal confirmation.`;

//     } catch (error) {
//       if (/Could not understand date|Invalid time calculation/.test(error.message)) {
//         return `Error: ${error.message}. Confirm the date and time with the caller again.`;
//       }
//       return calendarFailure(error, 'book appointment');
//     }
//   },
//   {
//     name: "book_appointment",
//     description: "Creates a 30-minute event on the Google Calendar. Input requires date, time, email, and name.",
//     schema: z.object({
//       date: z.string().describe("Date of meeting (YYYY-MM-DD)"),
//       time: z.string().describe("Time of meeting (e.g. '11:00 AM')"),
//       email: z.string().email().describe("User's email address"),
//       name: z.string().describe("User's full name"),
//     }),
//   }
// );















import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { google } from "googleapis";
import * as chrono from "chrono-node";
import "dotenv/config";
import { config } from '../config/index.js';

// --- CONFIGURATION ---
const CALENDAR_ID = config.calendar.calendarId;
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TIMEZONE = "Asia/Kolkata";
const SLOT_DURATION = 30; // 30 minutes slots

// --- AUTHENTICATION & TRANSPORTER ---
const auth = new google.auth.GoogleAuth({
  // Shared with the lead sheet, so one GOOGLE_KEY_FILE moves both.
  keyFile: config.google.keyFile,
  scopes: SCOPES,
});
const calendar = google.calendar({ version: "v3", auth });

const normalizeDate = (inputDate) => {
  // 1. Get the current time specifically in Asia/Kolkata
  const nowInIndia = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  
  // 2. Use 'nowInIndia' as the reference for relative dates like "upcoming friday"
  const parsedDate = chrono.parseDate(inputDate, nowInIndia, { forwardDate: true });

  if (!parsedDate) {
    const directDate = new Date(inputDate);
    if (!isNaN(directDate.getTime())) return directDate.toISOString().split('T')[0];
    throw new Error(`Could not understand date: "${inputDate}"`);
  }

  // 3. Ensure we don't accidentally jump to the next year prematurely
  const oneYearFromNow = new Date(nowInIndia);
  oneYearFromNow.setFullYear(nowInIndia.getFullYear() + 1);

  if (parsedDate > oneYearFromNow) {
     parsedDate.setFullYear(nowInIndia.getFullYear());
  }

  const year = parsedDate.getFullYear();
  const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
  const day = String(parsedDate.getDate()).padStart(2, '0');
  
  const finalDate = `${year}-${month}-${day}`;
  console.log(`[DEBUG] Input: "${inputDate}" -> Normalized to: ${finalDate}`);
  return finalDate;
};


// --- ERRORS ---
// One concise log line instead of the whole GaxiosError (80+ lines, request
// config included), and a message the MODEL can act on. A raw
// "Error: invalid_grant: Invalid JWT Signature" left the agent guessing what to
// tell the caller — and free to invent available slots.
let authFailureLogged = false;

function calendarFailure(error, action) {
  const status = error.code ?? error.response?.status;
  const detail =
    error.response?.data?.error_description ??
    error.response?.data?.error?.message ??
    error.message;
  const isAuth = /invalid_grant|invalid_client|unauthorized_client|JWT/i.test(detail) || status === 401;

  if (isAuth) {
    if (!authFailureLogged) {
      authFailureLogged = true;
      console.error(
        `❌ [CALENDAR] Google rejected the service account: ${detail}\n` +
        `   Diagnose with:  node scripts/check-google-auth.js`
      );
    } else {
      console.error(`❌ [CALENDAR] ${action}: auth still failing (${detail})`);
    }
    return (
      'CALENDAR_UNAVAILABLE: the calendar system cannot be reached right now. ' +
      'Tell the caller you cannot check or book the calendar at the moment, and that ' +
      'our team will call them back on this number to schedule the meeting. ' +
      'Do NOT offer, suggest or invent any times.'
    );
  }

  console.error(`❌ [CALENDAR] ${action} failed (${status ?? 'no status'}): ${detail}`);
  if (status === 404) return 'Error: Calendar ID not found. Check CALENDAR_ID in .env';
  if (status === 403) return 'Error: Service account does not have permission to write to this calendar.';
  return (
    `CALENDAR_ERROR: ${action} failed (${detail}). Tell the caller there was a problem ` +
    'with the calendar and offer to try again. Do NOT invent any times.'
  );
}

// --- TOOL 1: CHECK AVAILABILITY ---
export const checkAvailabilityTool = tool(
  async ({ date }) => {
    try {
      process.stdout.write(`\n>>> STARTING CALENDAR AVAILABILITY TOOL FOR DATE: ${date} <<<\n`);
      const formattedDate = normalizeDate(date);
      console.log(`[TOOL] Checking 30-min slots for ${formattedDate}...`);
 
      const timeMin = new Date(`${formattedDate}T00:00:00Z`).toISOString();
      const timeMax = new Date(`${formattedDate}T23:59:59Z`).toISOString();

      const response = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        orderBy: "startTime",
      });

      process.stdout.write(`✅ Found ${response.data.items.length} events for this day.\n`);
      const events = response.data.items;
      const busyTimes = events.map(event => ({
        start: new Date(event.start.dateTime || event.start.date),
        end: new Date(event.end.dateTime || event.end.date)
      }));

      const availableSlots = [];
      let currentSlot = new Date(`${formattedDate}T09:00:00`);
      const endOfDay = new Date(`${formattedDate}T17:00:00`);

      while (currentSlot < endOfDay) {
        const slotEnd = new Date(currentSlot.getTime() + SLOT_DURATION * 60 * 1000);
        const isBusy = busyTimes.some(busy => (currentSlot < busy.end && slotEnd > busy.start));

        if (!isBusy) {
          availableSlots.push(
            currentSlot.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
          );
        }
        currentSlot = slotEnd;
      }

      return availableSlots.length === 0
        ? "No slots available for this date."
        : `Available slots on ${formattedDate}: ${availableSlots.join(", ")}`;

    } catch (error) {
      if (/Could not understand date/.test(error.message)) {
        return `Error: ${error.message}. Ask the caller for the date again.`;
      }
      return calendarFailure(error, 'check availability');
    }
  },
  {
    name: "check_availability",
    description: "Check available 30-minute time slots for a specific date; you can check any date in the future.",
    schema: z.object({ 
        date: z.string().describe("Date like 'tomorrow' or '2026-05-20'; Date in YYYY-MM-DD format.") 
    }),
  }
);

// --- TOOL 2: BOOK APPOINTMENT ---
/** "14:30" -> "02:30 PM". The reverse of the parsing above, so what we report
 *  back is the slot the calendar actually holds. */
function to12Hour(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

export const bookAppointmentTool = tool(
  async ({ date, time, email, name }) => {
    const DURATION_MINUTES = 30;

    try {
      process.stdout.write(`\n>>> STARTING CALENDAR BOOKING TOOL FOR: ${name} <<<\n`);
      const formattedDate = normalizeDate(date);
      let cleanTime = time.trim().toUpperCase();

      // 1. Convert "11:00 AM" or "2:30 PM" to 24-hour "HH:mm"
      if (cleanTime.includes("PM") || cleanTime.includes("AM")) {
        const [timePart, modifier] = cleanTime.split(" ");
        let [hours, minutes] = timePart.split(":");

        if (hours === "12") hours = "00";
        if (modifier === "PM") hours = parseInt(hours, 10) + 12;

        cleanTime = `${String(hours).padStart(2, '0')}:${minutes}`;
      }

      const startDateTime = `${formattedDate}T${cleanTime}:00`;
      const startDate = new Date(startDateTime);

      if (isNaN(startDate.getTime())) {
        throw new Error(`Invalid time calculation. Resulted in: ${startDateTime}`);
      }

      const endDate = new Date(startDate.getTime() + DURATION_MINUTES * 60 * 1000);

      console.log(`[CALENDAR] Attempting booking for ${name} (${email}) at ${startDateTime}`);

      const response = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        resource: {
          summary: `Xverse Meeting: ${name || email}`,
          description: `Booked via Xverse AI Assistant. Contact: ${email}`,
          start: {
            dateTime: startDate.toISOString(),
            timeZone: TIMEZONE
          },
          end: {
            dateTime: endDate.toISOString(),
            timeZone: TIMEZONE
          },
          reminders: {
            useDefault: true
          }
        },
      });
      
      console.log(`✅ [CALENDAR] Success! Event ID: ${response.data.id}`);

      // Emit the date and time that were ACTUALLY booked, in a form the agent
      // node can parse. On a live call the caller asked for 12:00, that slot
      // was unavailable, the model proposed 11:30 and the caller agreed — but
      // it never re-ran the extraction, so the CRM kept 12:00 while the
      // calendar held 11:30. The calendar is the source of truth; this marker
      // is how it gets back into leadData instead of relying on the model
      // choosing to correct itself.
      const bookedTime = to12Hour(cleanTime);
      // name and email too: the model often passes them straight to this tool
      // without extracting them first, and then they were never saved — a
      // booked meeting whose contact email was null in the CRM.
      const booked = JSON.stringify({
        date: formattedDate,
        time: bookedTime,
        eventId: response.data.id,
        name,
        email,
      });

      return `SUCCESS: Calendar event created for ${formattedDate} at ${bookedTime}. ` +
        `ID: ${response.data.id}. [[BOOKED:${booked}]] ` +
        `You must now call the email tool to send the formal confirmation.`;

    } catch (error) {
      if (/Could not understand date|Invalid time calculation/.test(error.message)) {
        return `Error: ${error.message}. Confirm the date and time with the caller again.`;
      }
      return calendarFailure(error, 'book appointment');
    }
  },
  {
    name: "book_appointment",
    description: "Creates a 30-minute event on the Google Calendar. Input requires date, time, email, and name.",
    schema: z.object({
      date: z.string().describe("Date of meeting (YYYY-MM-DD)"),
      time: z.string().describe("Time of meeting (e.g. '11:00 AM')"),
      email: z.string().email().describe("User's email address"),
      name: z.string().describe("User's full name"),
    }),
  }
);