import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { STORAGE_PORT, StoragePort } from '../../../core/storage/storage.port';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { dayEnd, dayKey, dayStart } from '../../hos/engine/timezone';
import { activeMalfunctionCodes, buildSnapshot, uncertifiedDayCount } from '../../transfers/snapshot';
import { loadTripDetails } from '../../transfers/trip-details';
import { buildOutputFile } from '../../transfers/output-file';
import { validateOutputFile } from '../../transfers/validator';
import { buildOutputFileName, inclusiveDayCount } from '../../transfers/filename';
import { runPreSendChecks } from '../../transfers/pre-send-checks';
import { TransfersRepository } from '../../transfers/transfers.repository';
import { FMCSA_PACK_SECTIONS, type FmcsaPackParamsDto, type FmcsaPackSection } from '../dto/reports.dto';
import { renderPdf } from '../lib/pdf-render';

export interface FmcsaPackDriverEntry {
  driverId: string;
  driverName: string;
  status: 'INCLUDED' | 'SKIPPED';
  reason?: string;
  fileKey?: string;
  fileName?: string;
  uncertifiedDays?: number;
  malfunctionCodes?: string[];
  unidentifiedCount?: number;
  editCount?: number;
  dvirOpenDefects?: number;
}

export interface FmcsaPackResult {
  coverPdf: Buffer;
  driverEntries: FmcsaPackDriverEntry[];
}

/**
 * TZ §11.4/§11.6 `/reports/fmcsa-pack` — a per-driver §395 Appendix A output-file bundle plus
 * a cover PDF, for a period. Reuses Phase 9's `buildSnapshot`/`buildOutputFile`/
 * `validateOutputFile` (the SAME Appendix A generator `TransfersService.create` uses) so this
 * report can never diverge from what an inspector actually receives — it does not reimplement
 * the output file. Unlike `POST /transfers`, no `DataTransfer` row is created and nothing is
 * queued for sending: this is a read-only compliance snapshot for internal audit prep.
 */
@Injectable()
export class FmcsaPackGenerator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transfers: TransfersRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  private authenticationValue(eldIdentifier: string, eldRegistrationId: string, driverId: string): string {
    // Same derivation as `TransfersService.authenticationValue` — kept identical intentionally.
    return createHash('sha256')
      .update(`${eldIdentifier}:${eldRegistrationId}:${driverId}`)
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();
  }

  async build(params: FmcsaPackParamsDto, reportId: string): Promise<FmcsaPackResult> {
    const carrier = await this.transfers.findCarrier();
    if (!carrier) {
      return { coverPdf: await renderPdf('fmcsa-pack', { generatedAt: new Date().toISOString(), carrier: null, drivers: [] }), driverEntries: [] };
    }

    const drivers = await this.prisma.driver.findMany({
      where: { status: 'ACTIVE', ...(params.driverId ? { id: params.driverId } : {}) },
      orderBy: { id: 'asc' },
    });

    const rangeStart = new Date(`${params.from}T00:00:00.000Z`);
    const rangeEnd = new Date(`${params.to}T00:00:00.000Z`);
    const dayCount = inclusiveDayCount(rangeStart, rangeEnd);
    const generatedAt = new Date();

    // B-48 — no `include` ⇒ every section (the pack this generator built before the gap was
    // closed); an explicit list limits both the cover PDF columns and, for `RODS`, whether the
    // per-driver Appendix A output file is generated/attached at all.
    const sections = new Set(params.include ?? FMCSA_PACK_SECTIONS);
    const has = (section: FmcsaPackSection): boolean => sections.has(section);

    const entries: FmcsaPackDriverEntry[] = [];
    for (const driver of drivers) {
      const timezone = driver.homeTerminalTimezone ?? carrier.timezone;
      const fromInstant = dayStart(timezone, dayKey('UTC', rangeStart));
      const toInstant = dayEnd(timezone, dayKey('UTC', rangeEnd));

      const [events, unidentifiedEvents, dailyLogs, pendingSegments] = await Promise.all([
        this.transfers.findEvents(driver.id, fromInstant, toInstant),
        this.transfers.findUnidentifiedEvents(fromInstant, toInstant),
        this.transfers.findDailyLogs(driver.id, rangeStart, rangeEnd),
        this.transfers.findPendingUnidentifiedSegments(fromInstant, toInstant),
      ]);

      const vehicleIds = [
        ...new Set([...events, ...unidentifiedEvents].map((e) => e.vehicleId).filter((v): v is string => Boolean(v))),
      ];

      // B-48 — `vehicleId` filters WHICH DRIVERS the pack covers: a driver who never operated
      // the selected unit in the period has nothing to report for it, so is left out of the
      // pack entirely (not SKIPPED — SKIPPED means "should have been included but failed a
      // check"). No `vehicleId` ⇒ every active driver, unchanged from before this gap closed.
      // Checked BEFORE pre-send validation so an unrelated driver never produces a spurious
      // SKIPPED row.
      if (params.vehicleId && !vehicleIds.includes(params.vehicleId)) continue;

      const preSend = runPreSendChecks({
        driverExists: true,
        rangeStart,
        rangeEnd,
        unresolvedUnidentifiedCount: pendingSegments.length,
        uncertifiedDayCount: uncertifiedDayCount(dailyLogs, dayCount),
        activeMalfunctionCodes: activeMalfunctionCodes(events),
        erodsMode: carrier.erodsMode,
      });

      if (!preSend.canGenerate) {
        entries.push({
          driverId: driver.id,
          driverName: `${driver.lastName}, ${driver.firstName}`,
          status: 'SKIPPED',
          reason: preSend.errors[0]?.message ?? 'Pre-send validation failed.',
        });
        continue;
      }

      const editorIds = [...new Set(events.map((e) => e.editedById).filter((v): v is string => Boolean(v)))];
      const [vehicles, users] = await Promise.all([
        this.transfers.findVehicles(vehicleIds),
        this.transfers.findUsers(editorIds),
      ]);

      // B-48 §"DVIR" section — open defect count for this driver's DVIRs in the period
      // (scoped to `vehicleId` too, when given).
      const dvirOpenDefects = has('DVIR')
        ? await this.prisma.defect.count({
            where: {
              status: 'OPEN',
              dvir: {
                driverId: driver.id,
                submittedAt: { gte: rangeStart, lte: rangeEnd },
                ...(params.vehicleId ? { vehicleId: params.vehicleId } : {}),
              },
            },
          })
        : undefined;
      const unidentifiedCount = has('UNIDENTIFIED')
        ? unidentifiedEvents.filter((e) => !params.vehicleId || e.vehicleId === params.vehicleId).length
        : undefined;
      const editCount = has('EDITS') ? editorIds.length : undefined;
      const malfunctionCodes = has('MALFUNCTIONS') ? activeMalfunctionCodes(events) : [];

      // "RODS" section — the Appendix A output file itself. Every other section is metadata
      // ABOUT the driver's record; this is the record. Excluding it keeps the cover-page row
      // (status/counts) but skips building and storing the CSV.
      if (!has('RODS')) {
        entries.push({
          driverId: driver.id,
          driverName: `${driver.lastName}, ${driver.firstName}`,
          status: 'INCLUDED',
          uncertifiedDays: uncertifiedDayCount(dailyLogs, dayCount),
          malfunctionCodes,
          unidentifiedCount,
          editCount,
          dvirOpenDefects,
        });
        continue;
      }

      const tripDetails = await loadTripDetails(this.transfers, driver.id, timezone, params.from, params.to, generatedAt);
      const snapshot = buildSnapshot({
        driver,
        carrier,
        events,
        unidentifiedEvents,
        vehicles,
        users,
        dailyLogs,
        outputFileComment: `FMCSA COMPLIANCE PACK ${params.from}..${params.to}`.slice(0, 60),
        generatedAt,
        eldIdentifier: carrier.eldIdentifier,
        eldRegistrationId: carrier.eldRegistrationId ?? '',
        eldAuthenticationValue: this.authenticationValue(carrier.eldIdentifier, carrier.eldRegistrationId ?? '', driver.id),
        // D-129 — same header trailers / shipping documents as a single transfer.
        currentTripDetails: tripDetails.current,
        tripDetailsByDay: tripDetails.byDay,
      });

      const generated = buildOutputFile(snapshot);
      const validation = validateOutputFile(generated.csv);
      if (!validation.valid) {
        entries.push({
          driverId: driver.id,
          driverName: `${driver.lastName}, ${driver.firstName}`,
          status: 'SKIPPED',
          reason: `Output file failed Appendix A validation (${validation.issues.length} issue(s)).`,
        });
        continue;
      }

      // Appendix A 4.8.2.2(d): creation date in home-terminal time = the header's Current Date.
      const fileName = buildOutputFileName({
        lastName: driver.lastName,
        cdlNumber: driver.cdlNumber,
        sequence: 1,
        createdAt: generatedAt,
        timezoneOffsetMin: snapshot.driver.timezoneOffsetMin,
      });
      const fileKey = await this.storage.put(
        `reports/${reportId}/${driver.id}-${fileName}`,
        Buffer.from(generated.csv, 'utf8'),
        { contentType: 'text/csv' },
      );

      entries.push({
        driverId: driver.id,
        driverName: `${driver.lastName}, ${driver.firstName}`,
        status: 'INCLUDED',
        fileKey,
        fileName,
        uncertifiedDays: uncertifiedDayCount(dailyLogs, dayCount),
        malfunctionCodes,
        unidentifiedCount,
        editCount,
        dvirOpenDefects,
      });
    }

    const coverPdf = await renderPdf('fmcsa-pack', {
      generatedAt: generatedAt.toISOString(),
      carrier: { name: carrier.name, dot: carrier.dotNumber },
      period: { from: params.from, to: params.to },
      unitFilter: params.vehicleId ?? 'ALL',
      includeLabel: params.include ? params.include.join(', ') : 'ALL (full pack)',
      eldIdentifier: has('ELD_ID') ? carrier.eldIdentifier : '—',
      eldRegistrationId: has('ELD_ID') ? carrier.eldRegistrationId ?? '' : '—',
      drivers: entries.map((e) => ({
        ...e,
        malfunctionCodesLabel: e.malfunctionCodes?.length ? e.malfunctionCodes.join(', ') : '—',
      })),
    });

    return { coverPdf, driverEntries: entries };
  }
}
