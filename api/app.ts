import 'reflect-metadata';
import { Body, Controller, Get, Inject, Module, Param, ParseIntPipe, Post, Query, Catch, ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DomainError, InventoryStore } from './store';

const STORE = 'INVENTORY_STORE';
@Catch(DomainError)
class DomainErrorFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(error.status).json({ message: error.message, statusCode: error.status });
  }
}
@Controller('api')
class InventoryController {
  constructor(@Inject(STORE) private readonly store: InventoryStore) {}
  @Get('health') health() { return { status: 'ok', service: 'stocklane', data: 'synthetic demo' }; }
  @Get('dashboard') dashboard() { return this.store.snapshot(); }
  @Get('items') items(@Query('search') search?: string) { return this.store.items(typeof search === 'string' ? search : ''); }
  @Post('items') createItem(@Body() body: unknown) { return this.store.createItem(body); }
  @Post('items/:id/receipts') receive(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) { return this.store.receive(id, body); }
  @Get('orders') orders() { return this.store.orders(); }
  @Post('orders') createOrder(@Body() body: unknown) { return this.store.createOrder(body); }
  @Post('orders/:id/:action') transition(@Param('id', ParseIntPipe) id: number, @Param('action') action: string) { return this.store.transition(id, action); }
}
@Module({})
class AppModule {}

export async function createApp(options: { databasePath?: string; seed?: boolean; logger?: false } = {}) {
  const store = new InventoryStore(options.databasePath ?? process.env.DATABASE_PATH ?? 'data/stocklane.db', options.seed ?? true);
  const app = await NestFactory.create({ module: AppModule, controllers: [InventoryController], providers: [{ provide: STORE, useValue: store }] }, { logger: options.logger, bodyParser: false });
  app.use(express.json({ limit: '64kb' }));
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173' });
  app.useGlobalFilters(new DomainErrorFilter());
  const webPath = resolve(process.cwd(), 'dist/web');
  if (existsSync(webPath)) app.use(express.static(webPath));
  return { app, store, close: async () => { await app.close(); store.close(); } };
}
