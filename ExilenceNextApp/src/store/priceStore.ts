import { AxiosError } from 'axios';
import { action, computed, makeObservable, observable } from 'mobx';
import { fromStream } from 'mobx-utils';
import { forkJoin, from, interval, of } from 'rxjs';
import { catchError, concatMap, map, switchMap } from 'rxjs/operators';
import { rootStore } from '..';
import { IExternalPrice } from '../interfaces/external-price.interface';
import { filterPrices, findPrice } from '../utils/price.utils';
import { ILeaguePriceSource } from './../interfaces/league-price-source.interface';
import { poeninjaService } from './../services/poe-ninja.service';
import { LeaguePriceDetails } from './domains/league-price-details';
import { LeaguePriceSource } from './domains/league-price-source';
import { PriceSource } from './domains/price-source';
import { RootStore } from './rootStore';

export class PriceStore {
  @observable priceSources: PriceSource[] = [
    new PriceSource({
      name: 'poe-ninja',
      url: 'https://poe.ninja',
    }),
  ];

  @observable
  leaguePriceDetails: LeaguePriceDetails[] = [];
  @observable activePriceSourceUuid: string = '';
  @observable isUpdatingPrices: boolean = false;
  @observable pollingInterval: number = 60 * 1000 * 20;

  constructor(private rootStore: RootStore) {
    makeObservable(this);
    fromStream(
      interval(this.pollingInterval).pipe(
        switchMap(() => {
          if (!this.rootStore.uiStateStore.isSnapshotting) {
            return of(this.getPricesForLeagues());
          } else {
            return of(null);
          }
        })
      )
    );
  }

  @computed get exaltedPrice() {
    return this.activePricesWithCustomValues?.find((p) => p.name === 'Exalted Orb')?.calculated;
  }

  @computed get customPricesTableData() {
    const selectedLeagueId = this.rootStore.uiStateStore.selectedPriceTableLeagueId;
    const activeLeagueId = this.rootStore.accountStore.getSelectedAccount.activePriceLeague?.id;
    const leagueId = selectedLeagueId ? selectedLeagueId : activeLeagueId;
    const customLeaguePrices = this.rootStore.customPriceStore.customLeaguePrices.find(
      (lp) => lp.leagueId === leagueId
    );
    const leaguePriceDetails = this.leaguePriceDetails.find((l) => l.leagueId === leagueId);
    const leaguePriceSources = leaguePriceDetails?.leaguePriceSources;
    if (!leaguePriceSources || leaguePriceSources?.length === 0) {
      return;
    }
    const prices = leaguePriceSources[0]?.prices;
    if (!prices) {
      return;
    }
    return filterPrices(
      prices.filter((p) => {
        if (customLeaguePrices) {
          const foundCustomPrice = findPrice(customLeaguePrices?.prices, p);
          if (foundCustomPrice) {
            p.customPrice = foundCustomPrice.customPrice ? +foundCustomPrice.customPrice : 0;
          } else {
            p.customPrice = 0;
          }
        }
        return p;
      })
    );
  }

  @computed get activePricesWithCustomValues() {
    const activeLeagueId = this.rootStore.accountStore.getSelectedAccount.activePriceLeague?.id;
    const customLeaguePrices = this.rootStore.customPriceStore.customLeaguePrices.find(
      (lp) => lp.leagueId === activeLeagueId
    );
    const leaguePriceDetails = this.leaguePriceDetails.find((l) => l.leagueId === activeLeagueId);
    const leaguePriceSources = leaguePriceDetails?.leaguePriceSources;
    if (!leaguePriceSources || leaguePriceSources?.length === 0) {
      return;
    }
    const prices = leaguePriceSources[0]?.prices;
    if (!prices) {
      return;
    }
    return prices.filter((p) => {
      if (customLeaguePrices) {
        const foundCustomPrice = findPrice(customLeaguePrices?.prices, p);
        if (foundCustomPrice) {
          p.customPrice = foundCustomPrice.customPrice ? +foundCustomPrice.customPrice : 0;
        } else {
          p.customPrice = 0;
        }
      }
      return p;
    });
  }

  @computed get activePriceDetails() {
    const activeProfile = this.rootStore.accountStore.getSelectedAccount.activeProfile;
    if (activeProfile) {
      return this.leaguePriceDetails.find((l) => l.leagueId === activeProfile.activePriceLeagueId);
    } else return;
  }

  @action
  setActivePriceSource(uuid: string) {
    this.activePriceSourceUuid = uuid;
  }

  @action
  getLeaguePriceDetails(leagueId: string) {
    let leaguePriceDetails = this.leaguePriceDetails.find((l) => l.leagueId === leagueId);

    if (!leaguePriceDetails) {
      leaguePriceDetails = new LeaguePriceDetails();
      leaguePriceDetails.leagueId = leagueId;
      this.leaguePriceDetails.push(leaguePriceDetails);
    }

    return leaguePriceDetails;
  }

  @action
  getLeaguePriceSource(leaguePriceDetails: LeaguePriceDetails) {
    // todo: remove hardcoded check for poeninja
    let leaguePriceSource = leaguePriceDetails.leaguePriceSources.find(
      (lps) => lps.priceSourceUuid === this.priceSources[0].uuid
    );

    if (!leaguePriceSource) {
      leaguePriceSource = new LeaguePriceSource({
        priceSourceUuid: this.priceSources[0].uuid,
      } as ILeaguePriceSource);
      leaguePriceDetails.addLeaguePriceSource(leaguePriceSource);
    }

    return leaguePriceSource;
  }

  @action
  getPricesForLeagues() {
    const leagueIds = this.rootStore.leagueStore.priceLeagues.map((l) => l.id);
    this.isUpdatingPrices = true;
    fromStream(
      forkJoin(
        from(leagueIds).pipe(
          concatMap((leagueId: string) => {
            const league = this.rootStore.leagueStore.priceLeagues.find((l) => l.id === leagueId);

            const leaguePriceDetails = this.getLeaguePriceDetails(leagueId);

            if (!league) {
              throw Error('error:no_league');
            }
            return forkJoin(
              // todo: add watch and other sources here
              poeninjaService.getCurrencyPrices(league.id),
              poeninjaService.getItemPrices(league.id)
            ).pipe(
              map((prices) => {
                const combinedPrices: IExternalPrice[] = ([] as any).concat.apply(
                  [],
                  [prices[0], prices[1]]
                );
                const ninjaPrices: IExternalPrice[] = [];
                combinedPrices.forEach((p) => {
                  ninjaPrices.push(p);
                });

                const leaguePriceSource = this.getLeaguePriceSource(leaguePriceDetails);
                leaguePriceSource.updatePrices(ninjaPrices);
              })
            );
          })
        )
      ).pipe(
        switchMap(() => {
          return of(this.getPricesforLeaguesSuccess());
        }),
        catchError((e: AxiosError) => of(this.getPricesforLeaguesFail(e)))
      )
    );
  }

  @action
  getPricesforLeaguesSuccess() {
    this.isUpdatingPrices = false;
    this.rootStore.notificationStore.createNotification('get_prices_for_leagues', 'success');
  }

  @action
  getPricesforLeaguesFail(e: AxiosError | Error) {
    this.isUpdatingPrices = false;
    this.rootStore.notificationStore.createNotification('get_prices_for_leagues', 'error', true, e);
  }
}
