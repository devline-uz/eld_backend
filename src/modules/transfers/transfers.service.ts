import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Carrier, DataTransfer, EldEvent } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { QUEUES } from '../../core/queue/queue.constants';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { AuditRepository } from '../audit/audit.repository';
import { dayEnd, dayKey, dayStart } from '../hos/engine/timezone';
import { CreateTransferDto, TransferListQueryDto } from './dto/transfers.dto';
import { buildOutputFileName, inclusiveDayCount } from './filename';
import { FmcsaTransferService } from './fmcsa-transfer.service';
import { buildOutputFile } from './output-file';
import { PreSendFinding, runPreSendChecks } from './pre-send-checks';
import { activeMalfunctionCodes, buildSnapshot, uncertifiedDayCount } from './snapshot';
import { TransfersRepository } from './transfers.repository';
import { validateOutputFile } from './validator';

/** BullMQ payload of the `transfer` queue. */
export interface TransferJobData {
  transferId: string;
}

export interface TransferView {
  transfer: DataTransfer;
  /** §10.3 warnings — surfaced, never blocking. */
  warnings: PreSendFinding[];
  /** Appendix A data-line counts per segment. */
  counts: Record<string, number>;
}

/** Retention: `transfers/{transferId}.csv`, 24 months (tz.md §17). */
const TRANSFER_KEY_PREFIX = 'transfers';

/**
 * TZ §10 — eRODS. Generation, Appendix A validation, storage and download of the §395
 * output file.
 *
 * Generation runs in the request path on purpose: `DataTransfer.fileName`, `fileKey`,
 * `fileSizeBytes` and `checksum` are NOT NULL, and §395.24 requires the file to exist at
 * roadside immediately — an inspector cannot wait on a worker. The SEND step is the queued
 * part (`transfer.processor.ts`), which is where the TEST/PRODUCTION toggle applies.
 */
@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly repo: TransfersRepository,
    private readonly audit: AuditRepository,
    private readonly fmcsa: FmcsaTransferService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @InjectQueue(QUEUES.TRANSFER) private readonly queue: Queue<TransferJobData>,
  ) {}

  async create(dto: CreateTransferDto, actor: ContextUser): Promise<TransferView> {
    // A bad email recipient is rejected before any work is done (§10.4).
    this.fmcsa.assertValidRequest(dto.method, dto.recipient);

    const carrier = await this.requireCarrier();
    const driver = await this.repo.findDriver(dto.driverId);
    const timezone = driver?.homeTerminalTimezone ?? carrier.timezone;

    const rangeStart = dto.rangeStart;
    const rangeEnd = dto.rangeEnd;
    const dayCount = inclusiveDayCount(rangeStart, rangeEnd);

    const fromInstant = dayStart(timezone, dayKey('UTC', rangeStart));
    const toInstant = dayEnd(timezone, dayKey('UTC', rangeEnd));

    const [events, unidentifiedEvents, dailyLogs, pendingSegments] = driver
      ? await Promise.all([
          this.repo.findEvents(driver.id, fromInstant, toInstant),
          this.repo.findUnidentifiedEvents(fromInstant, toInstant),
          this.repo.findDailyLogs(driver.id, rangeStart, rangeEnd),
          this.repo.findPendingUnidentifiedSegments(fromInstant, toInstant),
        ])
      : [[] as EldEvent[], [] as EldEvent[], [], []];

    const preSend = runPreSendChecks({
      driverExists: Boolean(driver),
      rangeStart,
      rangeEnd,
      unresolvedUnidentifiedCount: pendingSegments.length,
      uncertifiedDayCount: uncertifiedDayCount(dailyLogs, dayCount),
      activeMalfunctionCodes: activeMalfunctionCodes(events),
      erodsMode: carrier.erodsMode,
    });

    if (!preSend.canGenerate || !driver) {
      const first = preSend.errors[0];
      throw AppException.unprocessable(
        first?.code === 'DRIVER_NOT_FOUND' ? ERROR_CODES.DRIVER_NOT_FOUND : ERROR_CODES.RANGE_TOO_LARGE,
        first?.message ?? 'Transfer request failed pre-send validation.',
        { findings: preSend.errors },
      );
    }

    // --- Appendix A file --------------------------------------------------------------
    const generatedAt = new Date();
    const vehicleIds = [
      ...new Set([...events, ...unidentifiedEvents].map((e) => e.vehicleId).filter((v): v is string => Boolean(v))),
    ];
    const editorIds = [...new Set(events.map((e) => e.editedById).filter((v): v is string => Boolean(v)))];
    const [vehicles, users] = await Promise.all([
      this.repo.findVehicles([...vehicleIds, ...(driver.assignedVehicleId ? [driver.assignedVehicleId] : [])]),
      this.repo.findUsers(editorIds),
    ]);

    const snapshot = buildSnapshot({
      driver,
      carrier,
      events,
      unidentifiedEvents,
      vehicles,
      users,
      dailyLogs,
      outputFileComment: dto.outputFileComment,
      generatedAt,
      eldIdentifier: carrier.eldIdentifier,
      eldRegistrationId: carrier.eldRegistrationId ?? '',
      eldAuthenticationValue: this.authenticationValue(carrier, driver.id),
    });

    const generated = buildOutputFile(snapshot);

    // §23 — the file is validated against Appendix A in TEST mode exactly as in PRODUCTION.
    const validation = validateOutputFile(generated.csv);
    if (!validation.valid) {
      this.logger.error({ issues: validation.issues }, 'Generated eRODS file failed Appendix A validation.');
      throw AppException.unprocessable(
        ERROR_CODES.OUTPUT_FILE_INVALID,
        'The generated output file does not conform to §395 Appendix A and was not stored.',
        { issues: validation.issues.slice(0, 20) },
      );
    }

    // --- file name (Appendix A 4.8.2.2) ----------------------------------------------
    const todayStart = dayStart(timezone, dayKey(timezone, generatedAt));
    const todayEnd = dayEnd(timezone, dayKey(timezone, generatedAt));
    const priorToday = await this.repo.countTransfersInWindow(driver.id, todayStart, todayEnd);
    const fileName = buildOutputFileName({
      lastName: driver.lastName,
      cdlNumber: driver.cdlNumber,
      sequence: priorToday + 1,
      createdAt: generatedAt,
      timezoneOffsetMin: snapshot.driver.timezoneOffsetMin,
    });

    const body = Buffer.from(generated.csv, 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex');
    const transfer = await this.repo.createTransfer({
      driverId: driver.id,
      method: dto.method,
      rangeStart,
      rangeEnd,
      outputFileComment: dto.outputFileComment,
      fileName,
      fileKey: 'pending',
      fileSizeBytes: body.length,
      checksum,
      encrypted: false,
      status: 'QUEUED',
      erodsMode: carrier.erodsMode,
      requestedById: actor.id,
      requestedByType: actor.type === 'driver' ? 'DRIVER' : 'USER',
      responseBody: dto.recipient ?? null,
    });

    const fileKey = await this.storage.put(`${TRANSFER_KEY_PREFIX}/${transfer.id}.csv`, body, {
      contentType: 'text/csv',
      metadata: { fileName, fileCheckValue: generated.fileCheckValue },
    });
    const stored = await this.repo.updateTransfer(transfer.id, { fileKey });

    await this.audit.insert({
      actorId: actor.id,
      actorType: actor.type === 'driver' ? 'DRIVER' : 'USER',
      action: 'ERODS_TRANSFER_REQUESTED',
      objectType: 'DataTransfer',
      objectId: transfer.id,
      after: {
        driverId: driver.id,
        method: dto.method,
        fileName,
        erodsMode: carrier.erodsMode,
        recipient: dto.recipient ?? null,
        fileCheckValue: generated.fileCheckValue,
        warnings: preSend.warnings.map((w) => w.code),
      },
      detail: `eRODS output file ${fileName} generated (${carrier.erodsMode} mode).`,
    });

    try {
      await this.queue.add('transfer.send', { transferId: transfer.id }, { removeOnComplete: true });
    } catch (err) {
      // A queue outage must not lose the file: it is stored and downloadable regardless.
      this.logger.error({ err, transferId: transfer.id }, 'Failed to enqueue the eRODS send job.');
    }

    return { transfer: stored, warnings: preSend.warnings, counts: validation.counts };
  }

  async list(query: TransferListQueryDto) {
    const page = await this.repo.listTransfers(
      {
        ...(query.driverId && { driverId: query.driverId }),
        ...(query.status !== 'ALL' && { status: query.status }),
      },
      query.page,
      query.limit,
    );
    const byId = await this.repo.resolveRequestedByMany(page.items);
    return { ...page, items: page.items.map((item) => withRequestedBy(item, byId)) };
  }

  /** B-46 — `requestedBy: { id, name }` on read. */
  async get(id: string) {
    const transfer = await this.repo.findTransfer(id);
    if (!transfer) throw AppException.notFound(`Transfer ${id} not found.`);
    const byId = await this.repo.resolveRequestedByMany([transfer]);
    return withRequestedBy(transfer, byId);
  }

  /**
   * §10.1 — in TEST mode the file "is saved to S3 and downloadable"; the same path serves
   * PRODUCTION. The stored bytes are re-validated against Appendix A and against the stored
   * checksum before they are handed out, so a corrupted object can never reach an inspector.
   */
  async download(id: string, actor: ContextUser): Promise<{ fileName: string; csv: string }> {
    const transfer = await this.get(id);
    const body = await this.storage.get(transfer.fileKey);
    const checksum = createHash('sha256').update(body).digest('hex');
    if (checksum !== transfer.checksum) {
      throw AppException.unprocessable(
        ERROR_CODES.CHECKSUM_MISMATCH,
        'The stored output file does not match its recorded checksum.',
        { transferId: id },
      );
    }
    const csv = body.toString('utf8');
    const validation = validateOutputFile(csv);
    if (!validation.valid) {
      throw AppException.unprocessable(
        ERROR_CODES.OUTPUT_FILE_INVALID,
        'The stored output file no longer conforms to §395 Appendix A.',
        { issues: validation.issues.slice(0, 20) },
      );
    }
    await this.audit.insert({
      actorId: actor.id,
      actorType: actor.type === 'driver' ? 'DRIVER' : 'USER',
      action: 'ERODS_TRANSFER_DOWNLOADED',
      objectType: 'DataTransfer',
      objectId: id,
      detail: `eRODS output file ${transfer.fileName} downloaded.`,
    });
    return { fileName: transfer.fileName, csv };
  }

  /** Raw stored bytes, for the worker's send step. */
  async loadFile(transfer: DataTransfer): Promise<Buffer> {
    return this.storage.get(transfer.fileKey);
  }

  private async requireCarrier(): Promise<Carrier> {
    const carrier = await this.repo.findCarrier();
    if (!carrier) throw AppException.notFound('Carrier profile is not configured.');
    return carrier;
  }

  /**
   * Appendix A "ELD Authentication Value": a per-driver value derived from the registered
   * ELD identity. Derived (not stored) so it is stable across regenerations of the same file
   * and cannot leak a secret. FMCSA's exact derivation is part of registration and is
   * confirmed with the identifier/registration id (tasks.md open question #2/#3).
   */
  private authenticationValue(carrier: Carrier, driverId: string): string {
    return createHash('sha256')
      .update(`${carrier.eldIdentifier}:${carrier.eldRegistrationId ?? ''}:${driverId}`)
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();
  }
}

/** B-46 — shapes `requestedById`/`requestedByType` into `{ id, name } | null` using the
 * batched lookup from `TransfersRepository.resolveRequestedByMany`. */
function withRequestedBy<T extends { requestedById: string | null; requestedByType: 'USER' | 'DRIVER' | 'SYSTEM' }>(
  transfer: T,
  byId: Map<string, { id: string; name: string }>,
): T & { requestedBy: { id: string; name: string } | null } {
  return { ...transfer, requestedBy: transfer.requestedById ? byId.get(transfer.requestedById) ?? null : null };
}
